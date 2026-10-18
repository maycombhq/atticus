package main

import (
	"context"
	"database/sql"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"google.golang.org/grpc"

	inventoryv1 "github.example.com/harbor/catalog/gen/harbor/inventory/v1"
	"github.example.com/harbor/catalog/internal/inventory"
	"github.example.com/harbor/catalog/internal/products"
)

func main() {
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Route("/products", func(r chi.Router) {
		r.Get("/", products.List(db))
		r.Get("/{id}", products.Get(db))
	})

	grpcServer := grpc.NewServer()
	inventoryv1.RegisterInventoryServer(grpcServer, inventory.NewServer(db))
	lis, err := net.Listen("tcp", ":9090")
	if err != nil {
		log.Fatal(err)
	}
	go func() { log.Fatal(grpcServer.Serve(lis)) }()

	go inventory.ConsumeOrders(context.Background(), db)

	log.Fatal(http.ListenAndServe(":8080", r))
}
