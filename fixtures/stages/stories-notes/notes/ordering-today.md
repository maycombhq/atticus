# How ordering works today

From the 2024 hand-over notes.

Orders arrive at POST /api/v2/orders, handled by OrderService.submit.
Stock is reserved after the order is saved.
