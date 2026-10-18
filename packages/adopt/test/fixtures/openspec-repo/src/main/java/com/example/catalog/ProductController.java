package com.example.catalog;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProductController {
  @GetMapping("/products/{sku}")
  public String product(@PathVariable String sku) {
    return sku;
  }
}
