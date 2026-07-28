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
	signalMu    sync.Mutex
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
	p.negotiationNeeded.Store(true)
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
	for _, other := range r.peers {
		if _, subscribed := other.subscribedTo.Load(p.id); subscribed {
			other.subscribedTo.Delete(p.id)
			other.negotiationNeeded.Store(true)
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
	r.markSubscribersForOwnerLocked(owner.id)
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
	if stillSharing {
		r.markSubscribersForOwnerLocked(owner.id)
	} else {
		r.clearSubscribersForOwnerLocked(owner.id)
	}
	r.mu.Unlock()

	if !stillSharing {
		owner.sharing.Store(false)
	}
	r.broadcastPeers()
	r.signalPeerConnections()
}

func (r *Room) markSubscribersForOwnerLocked(ownerID string) {
	for _, p := range r.peers {
		if _, subscribed := p.subscribedTo.Load(ownerID); subscribed {
			p.negotiationNeeded.Store(true)
		}
	}
}

func (r *Room) clearSubscribersForOwnerLocked(ownerID string) {
	for _, p := range r.peers {
		if _, subscribed := p.subscribedTo.Load(ownerID); subscribed {
			p.subscribedTo.Delete(ownerID)
			p.negotiationNeeded.Store(true)
		}
	}
}

// signalPeerConnections serializes offer creation and negotiates only peers
// whose subscriptions or publish direction changed. An unstable peer is
// retried without discarding offers already prepared for other peers.
func (r *Room) signalPeerConnections() {
	type pendingOffer struct {
		peer *Peer
		sdp  string
	}

	r.signalMu.Lock()
	defer r.signalMu.Unlock()

	r.mu.Lock()

	var pending []pendingOffer

	attemptSync := func() (tryAgain bool) {
		// Batch-remove closed peers in one pass — O(n) instead of the
		// original per-element splice that restarts the loop each time.
		n := 0
		for _, p := range r.peers {
			if p.pc.ConnectionState() != webrtc.PeerConnectionStateClosed {
				r.peers[n] = p
				n++
			}
		}
		for i := n; i < len(r.peers); i++ {
			r.peers[i] = nil // clear stale pointers for GC
		}
		r.peers = r.peers[:n]

		pending = pending[:0]

	peerLoop:
		for _, p := range r.peers {
			if !p.negotiationNeeded.Swap(false) {
				continue
			}
			if p.pc.SignalingState() != webrtc.SignalingStateStable {
				p.negotiationNeeded.Store(true)
				tryAgain = true
				continue
			}
			existingSenders := map[string]bool{}
			for _, sender := range p.pc.GetSenders() {
				if sender.Track() == nil {
					continue
				}
				trackID := sender.Track().ID()
				existingSenders[trackID] = true

				localTrack, ok := r.trackLocals[trackID]
				subscribed := false
				if ok {
					_, subscribed = p.subscribedTo.Load(localTrack.StreamID())
				}
				if !ok || !subscribed {
					if err := p.pc.RemoveTrack(sender); err != nil {
						log.Printf("peer %s: remove track %s: %v", p.id, trackID, err)
						p.negotiationNeeded.Store(true)
						tryAgain = true
						continue peerLoop
					}
					existingSenders[trackID] = false
				}
			}

			// Never send a peer its own published tracks back.
			for _, receiver := range p.pc.GetReceivers() {
				if receiver.Track() == nil {
					continue
				}
				existingSenders[receiver.Track().ID()] = true
			}

			for trackID, localTrack := range r.trackLocals {
				ownerID := localTrack.StreamID()
				_, subscribed := p.subscribedTo.Load(ownerID)

				if !existingSenders[trackID] && subscribed {
					sender, err := p.pc.AddTrack(localTrack)
					if err != nil {
						log.Printf("peer %s: add track %s: %v", p.id, trackID, err)
						p.negotiationNeeded.Store(true)
						tryAgain = true
						continue peerLoop
					}
					// Forward this viewer's keyframe requests (PLI/FIR) to the
					// publisher; without this a joining viewer stares at black
					// until the fallback ticker fires.
					go r.forwardRTCP(sender, trackID)
				}
			}

			offer, err := p.pc.CreateOffer(nil)
			if err != nil {
				log.Printf("peer %s: create offer: %v", p.id, err)
				p.negotiationNeeded.Store(true)
				tryAgain = true
				continue
			}
			if err = p.pc.SetLocalDescription(offer); err != nil {
				log.Printf("peer %s: set local offer: %v", p.id, err)
				p.negotiationNeeded.Store(true)
				tryAgain = true
				continue
			}

			pending = append(pending, pendingOffer{peer: p, sdp: offer.SDP})
		}
		return tryAgain
	}

	needsRetry := attemptSync()

	r.dispatchKeyFrameLocked()
	r.mu.Unlock()

	// Send offers outside the lock — a stalled client's 10s write deadline
	// no longer blocks track sync or SDP generation for the whole room.
	for _, o := range pending {
		if err := o.peer.send(msg{Type: "offer", SDP: o.sdp}); err != nil {
			log.Printf("peer %s: send offer: %v", o.peer.id, err)
		}
	}
	if needsRetry {
		time.AfterFunc(250*time.Millisecond, r.signalPeerConnections)
	}
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
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Sharing  bool     `json:"sharing"`
	Watchers []string `json:"watchers,omitempty"`
}

func (r *Room) peerList() []peerInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()

	watchers := make(map[string][]string)
	for _, watcher := range r.peers {
		watcher.subscribedTo.Range(func(key, value any) bool {
			targetID := key.(string)
			watchers[targetID] = append(watchers[targetID], watcher.name)
			return true
		})
	}

	list := make([]peerInfo, 0, len(r.peers))
	for _, p := range r.peers {
		list = append(list, peerInfo{
			ID:       p.id,
			Name:     p.name,
			Sharing:  p.sharing.Load(),
			Watchers: watchers[p.id],
		})
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
