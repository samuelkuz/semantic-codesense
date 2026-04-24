use std::collections::HashMap;

use test_rust_code::domain::{CustomerTier, Order, OrderItem, PaymentMethod, Warehouse};
use test_rust_code::notifications::ConsoleNotifier;
use test_rust_code::repository::InMemoryOrderRepository;
use test_rust_code::services::OrderProcessor;

fn main() {
    let items = vec![
        OrderItem {
            sku: "GLASS-MUG".to_string(),
            quantity: 2,
            unit_price_cents: 1_500,
            weight_grams: 300,
            fragile: true,
        },
        OrderItem {
            sku: "WINTER-BLANKET".to_string(),
            quantity: 1,
            unit_price_cents: 4_200,
            weight_grams: 900,
            fragile: false,
        },
    ];

    let mut order = Order::new(
        "order-100",
        "customer-42",
        CustomerTier::Gold,
        PaymentMethod::Card,
        items,
    );
    order.notes.push("rush shipment requested".to_string());

    let mut warehouse = Warehouse {
        location_code: "SEA-1".to_string(),
        inventory: HashMap::from([
            ("GLASS-MUG".to_string(), 6),
            ("WINTER-BLANKET".to_string(), 3),
        ]),
        reorder_threshold: 2,
    };

    let repository = InMemoryOrderRepository::new();
    let notifier = ConsoleNotifier::new();
    let mut processor = OrderProcessor::new(repository, notifier);

    let report = processor.process_order(order, &mut warehouse);
    println!("{report:#?}");
}
