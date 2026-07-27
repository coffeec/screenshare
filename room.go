package main

import (
	"log"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

var (
	roomsMu sync.Mutex
	rooms   = map[string]*Room{}
)

type Room struct {
	id          string
	mu          sync.RWMutex
	peers       []*Peer
	trackLocals map[string]*webrtc.TrackLocalStaticRTP
	stop        chan struct{}
	stopOnce    sync.Once

	pliMu   sync.Mutex
	lastPLI map[string]time.Time
}

// joinRoom gets or creates the room and adds p to it as one atomic step
// under roomsMu, so a room can never be deleted between lookup and join.
func joinRoom(id string, p *Peer) *Room {
	roomsMu.Lock()
	r, ok := rooms[id]
	if !ok {
		r = &Room{
			id:          id,
			trackLocals: map[string]*webrtc.TrackLocalStaticRTP{},
			stop:        make(chan struct{}),
			lastPLI:     map[string]time.Time{},
		}
		rooms[id] = r
		go r.keyFrameLoop()
		log.Printf("room %q created", id)
	}
	r.mu.Lock()
	r.peers = append(r.peers, p)
	r.mu.Unlock()
	roomsMu.Unlock()

	r.broadcastPeers()
	r.signalPeerConnections()
	return r
}

func (r *Room) removePeer(p *Peer) {
	roomsMu.Lock()
	r.mu.Lock()
	for i, other := range r.peers {
		if other == p {
			r.peers = append(r.peers[:i], r.peers[i+1:]...)
			break
		}
	}
	empty := len(r.peers) == 0
	if empty && rooms[r.id] == r {
		delete(rooms, r.id)
	}
	r.mu.Unlock()
	roomsMu.Unlock()

	if empty {
		r.stopOnce.Do(func() { close(r.stop) })
		log.Printf("room %q deleted", r.id)
		return
	}
	r.broadcastPeers()
	r.signalPeerConnections()
}

// addTrack mirrors a publisher's remote track as a local track.
// StreamID is set to the owner's peer ID so viewers can attribute tiles.
func (r *Room) addTrack(owner *Peer, t *webrtc.TrackRemote) *webrtc.TrackLocalStaticRTP {
	r.mu.Lock()
	local, err := webrtc.NewTrackLocalStaticRTP(t.Codec().RTPCodecCapability, t.ID(), owner.id)
	if err != nil {
		r.mu.Unlock()
		log.Printf("room %q: new local track: %v", r.id, err)
		return nil
	}
	r.trackLocals[t.ID()] = local
	r.mu.Unlock()

	owner.sharing.Store(true)
	r.broadcastPeers()
	r.signalPeerConnections()
	return local
}

func (r *Room) removeTrack(owner *Peer, local *webrtc.TrackLocalStaticRTP) {
	r.mu.Lock()
	delete(r.trackLocals, local.ID())
	stillSharing := false
	for _, t := range r.trackLocals {
		if t.StreamID() == owner.id {
			stillSharing = true
			break
		}
	}
	r.mu.Unlock()

	if !stillSharing {
		owner.sharing.Store(false)
	}
	r.broadcastPeers()
	r.signalPeerConnections()
}

// signalPeerConnections syncs senders on every peer with the room's track set
// and sends fresh offers. Ported from pion sfu-ws attemptSync.
func (r *Room) signalPeerConnections() {
	r.mu.Lock()
	defer func() {
		r.mu.Unlock()
	}()

	attemptSync := func() (tryAgain bool) {
		for i := range r.peers {
			p := r.peers[i]
			if p.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
				r.peers = append(r.peers[:i], r.peers[i+1:]...)
				return true
			}

			existingSenders := map[string]bool{}
			for _, sender := range p.pc.GetSenders() {
				if sender.Track() == nil {
					continue
				}
				existingSenders[sender.Track().ID()] = true
				if _, ok := r.trackLocals[sender.Track().ID()]; !ok {
					if err := p.pc.RemoveTrack(sender); err != nil {
						return true
					}
				}
			}

			// Never send a peer its own published tracks back.
			for _, receiver := range p.pc.GetReceivers() {
				if receiver.Track() == nil {
					continue
				}
				existingSenders[receiver.Track().ID()] = true
			}

			for trackID := range r.trackLocals {
				if !existingSenders[trackID] {
					sender, err := p.pc.AddTrack(r.trackLocals[trackID])
					if err != nil {
						return true
					}
					// Forward this viewer's keyframe requests (PLI/FIR) to the
					// publisher; without this a joining viewer stares at black
					// until the fallback ticker fires.
					go r.forwardRTCP(sender, trackID)
				}
			}

			if p.pc.SignalingState() != webrtc.SignalingStateStable {
				return true
			}

			offer, err := p.pc.CreateOffer(nil)
			if err != nil {
				return true
			}
			if err = p.pc.SetLocalDescription(offer); err != nil {
				return true
			}
			if err = p.send(msg{Type: "offer", SDP: offer.SDP}); err != nil {
				return true
			}
		}
		return false
	}

	for tries := 0; ; tries++ {
		if tries == 25 {
			// Release and retry later; something is mid-negotiation.
			go func() {
				time.Sleep(3 * time.Second)
				r.signalPeerConnections()
			}()
			return
		}
		if !attemptSync() {
			break
		}
	}
	r.dispatchKeyFrameLocked()
}

func (r *Room) keyFrameLoop() {
	// Slow safety net only — reactive keyframes come from forwardRTCP.
	// Frequent forced keyframes wreck 1080p60 quality: every I-frame burns
	// a large slice of the bitrate budget and the delay spike drags the
	// publisher's bandwidth estimate down.
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-ticker.C:
			r.mu.RLock()
			r.dispatchKeyFrameLocked()
			r.mu.RUnlock()
		}
	}
}

// forwardRTCP relays PLI/FIR from a viewer's sender back to the publisher
// of trackID. Exits when the sender is removed or its connection closes.
func (r *Room) forwardRTCP(sender *webrtc.RTPSender, trackID string) {
	for {
		pkts, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, pkt := range pkts {
			switch pkt.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				r.requestKeyFrame(trackID)
			}
		}
	}
}

// requestKeyFrame sends a PLI to whichever peer publishes trackID,
// debounced per track so several viewers don't cause a keyframe storm.
func (r *Room) requestKeyFrame(trackID string) {
	r.pliMu.Lock()
	if time.Since(r.lastPLI[trackID]) < 500*time.Millisecond {
		r.pliMu.Unlock()
		return
	}
	r.lastPLI[trackID] = time.Now()
	r.pliMu.Unlock()

	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, p := range r.peers {
		for _, receiver := range p.pc.GetReceivers() {
			t := receiver.Track()
			if t == nil || t.ID() != trackID {
				continue
			}
			_ = p.pc.WriteRTCP([]rtcp.Packet{
				&rtcp.PictureLossIndication{MediaSSRC: uint32(t.SSRC())},
			})
			return
		}
	}
}

// dispatchKeyFrameLocked asks every publisher for a keyframe. Caller holds r.mu.
func (r *Room) dispatchKeyFrameLocked() {
	for _, p := range r.peers {
		for _, receiver := range p.pc.GetReceivers() {
			if receiver.Track() == nil {
				continue
			}
			_ = p.pc.WriteRTCP([]rtcp.Packet{
				&rtcp.PictureLossIndication{MediaSSRC: uint32(receiver.Track().SSRC())},
			})
		}
	}
}

type peerInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Sharing bool   `json:"sharing"`
}

func (r *Room) peerList() []peerInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]peerInfo, 0, len(r.peers))
	for _, p := range r.peers {
		list = append(list, peerInfo{ID: p.id, Name: p.name, Sharing: p.sharing.Load()})
	}
	return list
}

func (r *Room) broadcastPeers() {
	list := r.peerList()
	r.mu.RLock()
	peers := make([]*Peer, len(r.peers))
	copy(peers, r.peers)
	r.mu.RUnlock()
	for _, p := range peers {
		_ = p.send(msg{Type: "peers", Peers: list})
	}
}
