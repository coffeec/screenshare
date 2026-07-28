package main

import (
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestOpusOfferRequestsMusicQualityStereo(t *testing.T) {
	mediaEngine, err := buildMediaEngine("h264")
	if err != nil {
		t.Fatal(err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}

	for _, parameter := range []string{"stereo=1", "sprop-stereo=1", "maxaveragebitrate=128000"} {
		if !strings.Contains(offer.SDP, parameter) {
			t.Errorf("Opus offer does not contain %q", parameter)
		}
	}
}
