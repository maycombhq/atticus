# catalog Specification

## Purpose

Shoppers can look up products by SKU.

## Requirements

### Requirement: Product lookup

The service SHALL return a product by its SKU.

#### Scenario: Known SKU

- **WHEN** a client asks for a SKU that exists
- **THEN** the service returns the product
