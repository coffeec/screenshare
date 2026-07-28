package main

import (
	"fmt"
	"net"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

// The server is the SDP offerer, and Chrome (answerer) picks its send codec
// from the OFFER's order — client-side setCodecPreferences is ignored for
// answers. So codec choice must be enforced here: one API per (network,
// codec-mode) pair, all sharing the same UDP/TCP mux.
var apis = map[string]*webrtc.API{} // key: "lan|wan" + "-" + "h264|vp9"

var videoFB = []webrtc.RTCPFeedback{
	{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"},
	{Type: "nack"}, {Type: "nack", Parameter: "pli"},
	{Type: "transport-cc"},
}

type codecDef struct {
	caps webrtc.RTPCodecCapability
	pt   webrtc.PayloadType
	rtx  webrtc.PayloadType
}

var (
	h264Codecs = []codecDef{
		{webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f", RTCPFeedback: videoFB}, 112, 113},
		{webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", RTCPFeedback: videoFB}, 108, 109},
		{webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", RTCPFeedback: videoFB}, 102, 103},
	}
	vp9Codecs = []codecDef{
		{webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP9, ClockRate: 90000, SDPFmtpLine: "profile-id=2", RTCPFeedback: videoFB}, 100, 101},
		{webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP9, ClockRate: 90000, SDPFmtpLine: "profile-id=0", RTCPFeedback: videoFB}, 98, 99},
	}
	vp8Codecs = []codecDef{
		{webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: videoFB}, 96, 97},
	}
)

func buildMediaEngine(mode string) (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine:  "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000",
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: "transport-cc"}},
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}

	var order []codecDef
	if mode == "vp9" {
		order = append(append(append(order, vp9Codecs...), h264Codecs...), vp8Codecs...)
	} else {
		order = append(append(append(order, h264Codecs...), vp8Codecs...), vp9Codecs...)
	}
	for _, c := range order {
		if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: c.caps, PayloadType: c.pt}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
		if err := m.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeRTX, ClockRate: 90000,
				SDPFmtpLine: fmt.Sprintf("apt=%d", c.pt),
			},
			PayloadType: c.rtx,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
	}
	return m, nil
}

func buildWebRTCAPI(bindIP string, udpPort, tcpPort int, publicIPs []string, extUDPPort int) error {
	// Bind media sockets to ONE interface: on 0.0.0.0 pion advertises a host
	// candidate per interface (docker0, tailscale0, ...); clients picking a
	// ghost candidate wreck their bandwidth estimate.
	var ip net.IP
	if bindIP != "" {
		ip = net.ParseIP(bindIP)
		if ip == nil {
			return fmt.Errorf("invalid -media-ip %q", bindIP)
		}
	}
	udpLn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip, Port: udpPort})
	if err != nil {
		return fmt.Errorf("listen udp %d: %w", udpPort, err)
	}
	udpMux := webrtc.NewICEUDPMux(nil, udpLn)

	tcpLn, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: ip, Port: tcpPort})
	if err != nil {
		return fmt.Errorf("listen tcp %d: %w", tcpPort, err)
	}
	tcpMux := webrtc.NewICETCPMux(nil, tcpLn, 8)

	for _, netKind := range []string{"lan", "wan"} {
		for _, mode := range []string{"h264", "vp9"} {
			m, err := buildMediaEngine(mode)
			if err != nil {
				return err
			}
			ir := &interceptor.Registry{}
			if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
				return err
			}
			se := webrtc.SettingEngine{}
			se.SetICEUDPMux(udpMux)
			se.SetICETCPMux(tcpMux)
			se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
			if netKind == "wan" && len(publicIPs) > 0 {
				// Host mapping rewrites the muxed-port candidate itself, so
				// it carries the frp node IP at the exact forwarded port.
				se.SetNAT1To1IPs(publicIPs, webrtc.ICECandidateTypeHost)
			}
			apis[netKind+"-"+mode] = webrtc.NewAPI(
				webrtc.WithMediaEngine(m),
				webrtc.WithInterceptorRegistry(ir),
				webrtc.WithSettingEngine(se),
			)
		}
	}
	return nil
}

// apiFor picks by the Host header the browser used (source IP is useless:
// frp-tunneled connections arrive with frpc's private source address) and
// the codec mode the client requested.
func apiFor(hostHeader, codecMode string) *webrtc.API {
	host := hostHeader
	if h, _, err := net.SplitHostPort(hostHeader); err == nil {
		host = h
	}
	netKind := "wan"
	ip := net.ParseIP(host)
	if ip != nil && (ip.IsPrivate() || ip.IsLoopback()) {
		netKind = "lan"
	}
	if codecMode != "vp9" {
		codecMode = "h264"
	}
	return apis[netKind+"-"+codecMode]
}
