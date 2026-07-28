package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func TestSignalPeerConnectionsOffersSubscribedTrack(t *testing.T) {
	serverWS, clientWS := websocketPair(t)
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
		"video-track",
		"publisher-id",
	)
	if err != nil {
		t.Fatal(err)
	}

	p := &Peer{id: "viewer-id", pc: pc, ws: serverWS}
	p.subscribedTo.Store("publisher-id", true)
	p.negotiationNeeded.Store(true)
	r := &Room{
		peers:       []*Peer{p},
		trackLocals: map[string]*webrtc.TrackLocalStaticRTP{track.ID(): track},
		lastPLI:     map[string]time.Time{},
	}

	r.signalPeerConnections()

	var offer msg
	if err := clientWS.ReadJSON(&offer); err != nil {
		t.Fatal(err)
	}
	if offer.Type != "offer" {
		t.Fatalf("message type = %q, want offer", offer.Type)
	}
	if !strings.Contains(offer.SDP, "publisher-id") || !strings.Contains(offer.SDP, "video-track") {
		t.Fatal("offer does not contain the subscribed publisher track")
	}
}

func TestSignalPeerConnectionsSkipsPeerWithoutPendingNegotiation(t *testing.T) {
	serverWS, _ := websocketPair(t)
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	p := &Peer{id: "viewer-id", pc: pc, ws: serverWS}
	r := &Room{peers: []*Peer{p}, lastPLI: map[string]time.Time{}}
	r.signalPeerConnections()

	if pc.LocalDescription() != nil {
		t.Fatal("peer without pending negotiation received an offer")
	}
}

func TestClearSubscribersForOwner(t *testing.T) {
	p := &Peer{}
	p.subscribedTo.Store("publisher-id", true)
	r := &Room{peers: []*Peer{p}}

	r.clearSubscribersForOwnerLocked("publisher-id")

	if _, subscribed := p.subscribedTo.Load("publisher-id"); subscribed {
		t.Fatal("stopped publisher still has a subscribed viewer")
	}
	if !p.negotiationNeeded.Load() {
		t.Fatal("viewer was not marked for track removal negotiation")
	}
}

func websocketPair(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	connections := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connections <- conn
	}))
	t.Cleanup(server.Close)

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	serverConn := <-connections
	t.Cleanup(func() {
		_ = serverConn.Close()
		_ = client.Close()
	})
	return serverConn, client
}
