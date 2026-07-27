package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
)

//go:embed static
var staticFS embed.FS

type config struct {
	httpsAddr      string
	mediaUDPPort   int
	mediaTCPPort   int
	mediaIP        string
	publicHost     string
	publicUDPPort  int
	token          string
	certFile       string
	keyFile        string
}

var cfg config

func main() {
	flag.StringVar(&cfg.httpsAddr, "https-addr", envOr("SS_HTTPS_ADDR", ":8443"), "HTTPS listen address")
	flag.IntVar(&cfg.mediaUDPPort, "media-udp-port", 42000, "UDP port for all WebRTC media (ICE UDP mux)")
	flag.IntVar(&cfg.mediaTCPPort, "media-tcp-port", 8444, "TCP port for ICE-TCP fallback")
	flag.StringVar(&cfg.mediaIP, "media-ip", envOr("SS_MEDIA_IP", ""), "specific interface IP to bind media sockets to (avoids ghost candidates from docker/vpn interfaces)")
	flag.StringVar(&cfg.publicHost, "public-host", envOr("SS_PUBLIC_HOST", ""), "public hostname or IP advertised in ICE candidates (e.g. SakuraFrp node)")
	flag.IntVar(&cfg.publicUDPPort, "public-udp-port", 0, "external UDP port if different from -media-udp-port (e.g. SakuraFrp mapped port)")
	flag.StringVar(&cfg.token, "token", envOr("SS_TOKEN", ""), "shared access token (generated if empty)")
	flag.StringVar(&cfg.certFile, "cert", envOr("SS_CERT", "cert.pem"), "TLS certificate file")
	flag.StringVar(&cfg.keyFile, "key", envOr("SS_KEY", "key.pem"), "TLS key file")
	flag.Parse()

	if cfg.token == "CHANGE_ME" {
		log.Fatal("refusing to start with the placeholder token; edit -token in the systemd unit")
	}
	if cfg.token == "" {
		log.Print("no token set: auth disabled")
	}

	var publicIPs []string
	if cfg.publicHost != "" {
		ips, err := net.LookupIP(cfg.publicHost)
		if err != nil {
			log.Fatalf("resolve public host %q: %v", cfg.publicHost, err)
		}
		for _, ip := range ips {
			if v4 := ip.To4(); v4 != nil {
				publicIPs = append(publicIPs, v4.String())
				break // pion's NAT1To1 mapping is 1:1; a second IP would make ICE gathering fail
			}
		}
		if len(publicIPs) == 0 {
			log.Fatalf("public host %q has no IPv4 address", cfg.publicHost)
		}
		log.Printf("advertising public IP: %s", publicIPs[0])
	}

	extUDPPort := cfg.publicUDPPort
	if extUDPPort == 0 {
		extUDPPort = cfg.mediaUDPPort
	}
	if err := buildWebRTCAPI(cfg.mediaIP, cfg.mediaUDPPort, cfg.mediaTCPPort, publicIPs, extUDPPort); err != nil {
		log.Fatalf("webrtc setup: %v", err)
	}

	static, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/auth", handleAuth)
	mux.HandleFunc("/ws", handleWebSocket)

	log.Printf("listening on https://%s (media udp:%d tcp:%d)", cfg.httpsAddr, cfg.mediaUDPPort, cfg.mediaTCPPort)
	srv := &http.Server{Addr: cfg.httpsAddr, Handler: mux}
	log.Fatal(srv.ListenAndServeTLS(cfg.certFile, cfg.keyFile))
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func newID(bytes int) string {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		log.Fatal(err)
	}
	return hex.EncodeToString(b)
}
