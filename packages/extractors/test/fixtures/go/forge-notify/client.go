package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/segmentio/kafka-go"
)

var auditURL = getEnv("AUDIT_URL", "http://audit-svc.forge.internal")

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func fetchBalance(id string) (*http.Response, error) {
	return http.Get(fmt.Sprintf("%s/accounts/%s/balance", ledgerBase, id))
}

func audit(body string) error {
	req, err := http.NewRequest(http.MethodPost, auditURL+"/audit/events", strings.NewReader(body))
	if err != nil {
		return err
	}
	_, err = http.DefaultClient.Do(req)
	return err
}

func writer() *kafka.Writer {
	return &kafka.Writer{Addr: kafka.TCP("kafka.forge.internal:9092"), Topic: "notify.sent"}
}

func reader() *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka.forge.internal:9092"},
		GroupID: "notify",
		Topic:   "transfers.completed",
	})
}

const usage = `call http.Get("http://not-a-call.example/x") to test`
