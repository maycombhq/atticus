package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

const ledgerBase = "http://ledger-api.forge.internal"

func main() {
	r := gin.Default()
	r.GET("/healthz", health)
	// r.GET("/debug/pprof", pprofHandler)
	v1 := r.Group("/v1")
	{
		v1.POST("/notifications", send)
		v1.GET("/notifications/:id", get)
	}
	registerAdmin(v1.Group("/admin"))
	_ = http.ListenAndServe(":8080", r)
}

func registerAdmin(rg *gin.RouterGroup) {
	rg.DELETE("/cache/:key", clearCache)
}
