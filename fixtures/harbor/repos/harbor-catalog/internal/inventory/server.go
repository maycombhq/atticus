package inventory

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/segmentio/kafka-go"

	inventoryv1 "github.example.com/harbor/catalog/gen/harbor/inventory/v1"
)

// Server implements harbor.inventory.v1.Inventory (proto/harbor/inventory/v1/inventory.proto).
type Server struct {
	inventoryv1.UnimplementedInventoryServer
	db *sql.DB
}

func NewServer(db *sql.DB) *Server { return &Server{db: db} }

func (s *Server) CheckStock(ctx context.Context, req *inventoryv1.CheckStockRequest) (*inventoryv1.CheckStockResponse, error) {
	var onHand int32
	err := s.db.QueryRowContext(ctx, "SELECT on_hand FROM stock_levels WHERE sku = $1", req.GetSku()).Scan(&onHand)
	if err != nil {
		return nil, err
	}
	return &inventoryv1.CheckStockResponse{Available: onHand >= req.GetQuantity(), OnHand: onHand}, nil
}

func (s *Server) ReserveStock(ctx context.Context, req *inventoryv1.ReserveStockRequest) (*inventoryv1.ReserveStockResponse, error) {
	_, err := s.db.ExecContext(ctx, "UPDATE stock_levels SET on_hand = on_hand - $2 WHERE sku = $1", req.GetSku(), req.GetQuantity())
	return &inventoryv1.ReserveStockResponse{Reserved: err == nil}, err
}

type orderPlaced struct {
	OrderID string `json:"orderId"`
	Lines   []struct {
		SKU      string `json:"sku"`
		Quantity int32  `json:"quantity"`
	} `json:"lines"`
}

// ConsumeOrders lowers stock when an order is placed.
func ConsumeOrders(ctx context.Context, db *sql.DB) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka.harbor.internal:9092"},
		GroupID: "catalog-svc",
		Topic:   "orders.placed",
	})
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			return
		}
		var evt orderPlaced
		if json.Unmarshal(msg.Value, &evt) != nil {
			continue
		}
		for _, l := range evt.Lines {
			_, _ = db.ExecContext(ctx, "UPDATE stock_levels SET on_hand = on_hand - $2 WHERE sku = $1", l.SKU, l.Quantity)
		}
	}
}
