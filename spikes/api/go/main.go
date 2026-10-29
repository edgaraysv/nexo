package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal("invalid database configuration")
	}
	cfg.MaxConns = 24
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		log.Fatal("database unavailable")
	}
	defer pool.Close()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		send := func(status int, body string) { w.WriteHeader(status); _, _ = io.WriteString(w, body) }
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
		if err != nil {
			send(413, `{"error":"body_too_large"}`)
			return
		}
		if len(data) == 0 {
			data = []byte(`{}`)
		}
		if !json.Valid(data) {
			send(422, `{"error":"invalid_json"}`)
			return
		}
		var status int
		var payload []byte
		err = pool.QueryRow(r.Context(), "SELECT * FROM api_call($1,$2,$3,$4,$5::jsonb)",
			r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Idempotency-Key"), string(data)).Scan(&status, &payload)
		if err != nil {
			send(500, `{"error":"internal_error"}`)
			return
		}
		send(status, string(payload))
	})
	s := &http.Server{Addr: ":8080", Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second}
	log.Fatal(s.ListenAndServe())
}
