package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	wsWriteWait = 10 * time.Second
	// Generous pong window with frequent pings: through the frp double-hop
	// a pong can be seconds late; a tight window misreads that as a dead
	// connection and kicks healthy viewers every ~30s.
	wsPongWait  = 60 * time.Second
	wsPingEvery = 20 * time.Second
	wsMaxMsg    = 64 * 1024
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

type msg struct {
	Type      string                   `json:"type"`
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	SelfID    string                   `json:"selfId,omitempty"`
	Peers     []peerInfo               `json:"peers,omitempty"`
	Message   string                   `json:"message,omitempty"`
	TargetID  string                   `json:"targetId,omitempty"`
}

type Peer struct {
	id      string
	name    string
	pc      *webrtc.PeerConnection
	ws           *websocket.Conn
	wsMu         sync.Mutex
	sharing      atomic.Bool
	subscribedTo sync.Map
}

func (p *Peer) send(m msg) error {
	p.wsMu.Lock()
	defer p.wsMu.Unlock()
	// Bounds how long a stalled/half-open client can block signalPeerConnections,
	// which holds the room lock for the whole broadcast.
	_ = p.ws.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return p.ws.WriteJSON(m)
}

// keepalive pings the client and enforces a read deadline so dead
// connections (laptop sleep, network drop) are detected and cleaned up
// instead of leaking a Peer + PeerConnection forever.
func (p *Peer) keepalive() {
	ticker := time.NewTicker(wsPingEvery)
	defer ticker.Stop()
	for range ticker.C {
		p.wsMu.Lock()
		_ = p.ws.SetWriteDeadline(time.Now().Add(wsWriteWait))
		err := p.ws.WriteMessage(websocket.PingMessage, nil)
		p.wsMu.Unlock()
		if err != nil {
			return
		}
	}
}

func tokenOK(r *http.Request) bool {
	if cfg.token == "" {
		return true
	}
	got := r.URL.Query().Get("token")
	return subtle.ConstantTimeCompare([]byte(got), []byte(cfg.token)) == 1
}

// handleAuth lets the join form check whether a token is needed and valid.
func handleAuth(w http.ResponseWriter, r *http.Request) {
	if !tokenOK(r) {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if !tokenOK(r) {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	roomID := r.URL.Query().Get("room")
	name := r.URL.Query().Get("name")
	if roomID == "" || name == "" {
		http.Error(w, "room and name required", http.StatusBadRequest)
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	ws.SetReadLimit(wsMaxMsg)
	_ = ws.SetReadDeadline(time.Now().Add(wsPongWait))
	ws.SetPongHandler(func(string) error {
		_ = ws.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	pc, err := apiFor(r.Host, r.URL.Query().Get("codec")).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		log.Printf("new pc: %v", err)
		ws.Close()
		return
	}

	peer := &Peer{id: newID(8), name: name, pc: pc, ws: ws}
	go peer.keepalive()
	var room *Room // assigned once setup is complete; OnTrack only fires after negotiation

	// Pre-add recvonly transceivers so the publish m-lines always exist;
	// the client's addTrack reuses them mid-session without adding m-lines.
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			log.Printf("add transceiver: %v", err)
			pc.Close()
			ws.Close()
			return
		}
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		if err := peer.send(msg{Type: "candidate", Candidate: &init}); err != nil {
			log.Printf("peer %s: send candidate: %v", peer.id, err)
		}
	})

	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		log.Printf("peer %s(%s): ICE %s", peer.id, peer.name, s)
		if s == webrtc.ICEConnectionStateConnected {
			if sctp := pc.SCTP(); sctp != nil {
				if t := sctp.Transport(); t != nil {
					if pair, err := t.ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
						log.Printf("peer %s(%s): path %s <-> %s", peer.id, peer.name, pair.Local, pair.Remote)
					}
				}
			}
		}
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("peer %s(%s): PC %s", peer.id, peer.name, s)
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			ws.Close()
		}
	})

	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("peer %s(%s): publishing %s track %s codec=%s", peer.id, peer.name, t.Kind(), t.ID(), t.Codec().MimeType)
		local := room.addTrack(peer, t)
		if local == nil {
			return
		}
		defer room.removeTrack(peer, local)
		for {
			pkt, _, err := t.ReadRTP()
			if err != nil {
				return
			}
			pkt.Extension = false
			pkt.Extensions = nil
			if err = local.WriteRTP(pkt); err != nil {
				return
			}
		}
	})

	// Welcome must reach the client before joinRoom triggers the first offer:
	// the client only creates its RTCPeerConnection upon 'welcome', and drops
	// any offer that arrives before that. The full peer list follows in the
	// 'peers' broadcast right after the join.
	if err := peer.send(msg{Type: "welcome", SelfID: peer.id}); err != nil {
		pc.Close()
		ws.Close()
		return
	}

	log.Printf("peer %s(%s) joined room %q via host %q", peer.id, peer.name, roomID, r.Host)
	room = joinRoom(roomID, peer)
	defer func() {
		pc.Close()
		ws.Close()
		room.removePeer(peer)
		log.Printf("peer %s(%s) left room %q", peer.id, peer.name, roomID)
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		_ = ws.SetReadDeadline(time.Now().Add(wsPongWait))
		var m msg
		if err := json.Unmarshal(raw, &m); err != nil {
			log.Printf("peer %s: bad message: %v", peer.id, err)
			continue
		}
		switch m.Type {
		case "ping":
			// app-level keepalive from the browser; read deadline is extended
			// by any inbound frame, so nothing else to do
		case "answer":
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{
				Type: webrtc.SDPTypeAnswer, SDP: m.SDP,
			}); err != nil {
				log.Printf("peer %s: set answer: %v", peer.id, err)
			}
		case "candidate":
			if m.Candidate != nil {
				if err := pc.AddICECandidate(*m.Candidate); err != nil {
					log.Printf("peer %s: add candidate: %v", peer.id, err)
				}
			}
		case "renegotiate":
			room.signalPeerConnections()
		case "subscribe":
			if m.TargetID != "" {
				peer.subscribedTo.Store(m.TargetID, true)
				room.signalPeerConnections()
				room.broadcastPeers()
			}
		case "unsubscribe":
			if m.TargetID != "" {
				peer.subscribedTo.Delete(m.TargetID)
				room.signalPeerConnections()
				room.broadcastPeers()
			}
		case "stop-share":
			// Track removal happens when ReadRTP errors after the client
			// stops its tracks; renegotiate promptly instead of waiting.
			room.signalPeerConnections()
		default:
			log.Printf("peer %s: unknown message type %q", peer.id, m.Type)
		}
	}
}
