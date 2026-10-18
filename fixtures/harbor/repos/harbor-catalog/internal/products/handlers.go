package products

import (
	"database/sql"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Product struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	PriceCents  int    `json:"priceCents"`
}

// List answers GET /products with the first page of the catalog.
func List(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.QueryContext(r.Context(), "SELECT sku, name, description, price_cents FROM products ORDER BY name LIMIT 50")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		var out []Product
		for rows.Next() {
			var p Product
			_ = rows.Scan(&p.ID, &p.Name, &p.Description, &p.PriceCents)
			out = append(out, p)
		}
		_ = json.NewEncoder(w).Encode(out)
	}
}

// Get answers GET /products/{id}.
func Get(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var p Product
		err := db.QueryRowContext(r.Context(), "SELECT sku, name, description, price_cents FROM products WHERE sku = $1", chi.URLParam(r, "id")).
			Scan(&p.ID, &p.Name, &p.Description, &p.PriceCents)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(p)
	}
}
