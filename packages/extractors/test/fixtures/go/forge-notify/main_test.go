package main

import "testing"

func TestRoutes(t *testing.T) {
	r := gin.New()
	r.GET("/only-in-tests", nil)
}
