package main

import (
	ledgerpb "harbor/ledger/v1"
	ratespb "harbor/rates/v1"
	"harbor/internal/rpcserver"
)

func main() {
	s := rpcserver.New()
	ledgerpb.RegisterLedgerServiceServer(s, &server{})
	conn := rpcserver.Dial("rates:50051")
	rates := ratespb.NewRatesServiceClient(conn)
	_ = rates
	// ledgerpb.NewLedgerServiceClient(conn) is not used
}
