use crate::domain::{Order, OrderStatus, PaymentMethod, Warehouse};
use crate::notifications::{
    Notifier, build_failure_message, notify_low_inventory, notify_order_processed,
};
use crate::pricing::{compute_order_total, requires_manual_review};
use crate::repository::OrderRepository;

#[derive(Clone, Debug)]
pub struct ProcessingReport {
    pub order_id: String,
    pub status: OrderStatus,
    pub total_cents: Option<u64>,
    pub notes: Vec<String>,
}

pub struct OrderProcessor<R, N> {
    pub repository: R,
    pub notifier: N,
}

impl<R, N> OrderProcessor<R, N>
where
    R: OrderRepository,
    N: Notifier,
{
    pub fn new(repository: R, notifier: N) -> Self {
        Self {
            repository,
            notifier,
        }
    }

    /// Coordinates inventory reservation, billing, persistence, and notifications.
    pub fn process_order(
        &mut self,
        mut order: Order,
        warehouse: &mut Warehouse,
    ) -> ProcessingReport {
        self.repository.save(order.clone());

        if !self.reserve_inventory(&order, warehouse) {
            return self.handle_failure(&order, "inventory unavailable");
        }

        let total_cents = compute_order_total(&order);

        if requires_manual_review(&order, total_cents) {
            order.flagged_for_review = true;
            let review_note = format!("manual review requested for total {total_cents}");
            self.repository.append_audit(&order.id, review_note);
        }

        match self.settle_payment(&order, total_cents) {
            Ok(receipt_code) => {
                self.finalize_order(&mut order, warehouse, total_cents, receipt_code);
                self.repository.save(order.clone());

                ProcessingReport {
                    order_id: order.id.clone(),
                    status: order.status.clone(),
                    total_cents: Some(total_cents),
                    notes: order.audit_log.clone(),
                }
            }
            Err(reason) => self.handle_failure(&order, &reason),
        }
    }

    fn reserve_inventory(&mut self, order: &Order, warehouse: &mut Warehouse) -> bool {
        if order
            .items
            .iter()
            .any(|item| warehouse.inventory_for(&item.sku) < item.quantity)
        {
            return false;
        }

        for item in &order.items {
            if let Some(units) = warehouse.inventory.get_mut(&item.sku) {
                *units -= item.quantity;
            }
        }

        true
    }

    fn settle_payment(&mut self, order: &Order, total_cents: u64) -> Result<String, String> {
        match order.payment_method {
            PaymentMethod::Card => Ok(format!("card-{}-{total_cents}", order.id)),
            PaymentMethod::Invoice if total_cents > 100_000 => {
                Err("invoice limit exceeded".to_string())
            }
            PaymentMethod::Invoice => Ok(format!("invoice-{}-{total_cents}", order.id)),
            PaymentMethod::WireTransfer if order.flagged_for_review => {
                Err("wire transfer blocked pending review".to_string())
            }
            PaymentMethod::WireTransfer => Ok(format!("wire-{}-{total_cents}", order.id)),
        }
    }

    fn finalize_order(
        &mut self,
        order: &mut Order,
        warehouse: &Warehouse,
        total_cents: u64,
        receipt_code: String,
    ) {
        order.mark_paid(receipt_code);
        self.repository.mark_status(&order.id, OrderStatus::Paid);
        self.repository
            .append_audit(&order.id, format!("final total was {total_cents}"));

        let _ = notify_order_processed(&mut self.notifier, order, total_cents);

        for item in &order.items {
            if warehouse.is_low_stock(&item.sku) {
                let _ = notify_low_inventory(&mut self.notifier, warehouse, &item.sku);
            }
        }
    }

    fn handle_failure(&mut self, order: &Order, reason: &str) -> ProcessingReport {
        self.repository.mark_status(&order.id, OrderStatus::Failed);
        self.repository
            .append_audit(&order.id, format!("processing failed: {reason}"));

        let subject = format!("Order {} failed", order.id);
        let body = build_failure_message(order, reason);
        let _ = self.notifier.send(&subject, &body);

        ProcessingReport {
            order_id: order.id.clone(),
            status: OrderStatus::Failed,
            total_cents: None,
            notes: vec![reason.to_string()],
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::domain::{CustomerTier, Order, OrderItem, PaymentMethod, Warehouse};
    use crate::notifications::ConsoleNotifier;
    use crate::repository::InMemoryOrderRepository;

    use super::OrderProcessor;

    fn build_order() -> Order {
        Order::new(
            "order-test",
            "customer-test",
            CustomerTier::Platinum,
            PaymentMethod::Card,
            vec![
                OrderItem {
                    sku: "GLASS-BOWL".to_string(),
                    quantity: 1,
                    unit_price_cents: 3_500,
                    weight_grams: 400,
                    fragile: true,
                },
                OrderItem {
                    sku: "LIMITED-CANDLE".to_string(),
                    quantity: 1,
                    unit_price_cents: 2_000,
                    weight_grams: 150,
                    fragile: false,
                },
            ],
        )
    }

    fn build_warehouse(glass_units: u32, candle_units: u32) -> Warehouse {
        Warehouse {
            location_code: "PDX-1".to_string(),
            inventory: HashMap::from([
                ("GLASS-BOWL".to_string(), glass_units),
                ("LIMITED-CANDLE".to_string(), candle_units),
            ]),
            reorder_threshold: 1,
        }
    }

    #[test]
    fn process_order_happy_path_marks_order_paid() {
        let repository = InMemoryOrderRepository::new();
        let notifier = ConsoleNotifier::new();
        let mut processor = OrderProcessor::new(repository, notifier);
        let mut warehouse = build_warehouse(4, 3);

        let report = processor.process_order(build_order(), &mut warehouse);

        assert_eq!(report.order_id, "order-test");
        assert!(report.total_cents.is_some());
        assert_eq!(processor.notifier.sent_messages.len(), 1);
    }

    #[test]
    fn process_order_fails_when_inventory_is_missing() {
        let repository = InMemoryOrderRepository::new();
        let notifier = ConsoleNotifier::new();
        let mut processor = OrderProcessor::new(repository, notifier);
        let mut warehouse = build_warehouse(0, 3);

        let report = processor.process_order(build_order(), &mut warehouse);

        assert!(report.total_cents.is_none());
        assert_eq!(report.notes, vec!["inventory unavailable".to_string()]);
        assert_eq!(processor.notifier.sent_messages.len(), 1);
    }
}
