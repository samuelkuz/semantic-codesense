use crate::domain::{Order, Warehouse};

pub trait Notifier {
    fn send(&mut self, subject: &str, body: &str) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct ConsoleNotifier {
    pub sent_messages: Vec<String>,
    pub fail_next: bool,
}

impl ConsoleNotifier {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Notifier for ConsoleNotifier {
    fn send(&mut self, subject: &str, body: &str) -> Result<(), String> {
        if self.fail_next {
            self.fail_next = false;
            return Err("simulated notifier failure".to_string());
        }

        self.sent_messages.push(format!("{subject} => {body}"));
        Ok(())
    }
}

pub fn build_order_summary(order: &Order, total_cents: u64) -> String {
    format!(
        "order={} items={} total_cents={} priority={} review={}",
        order.id,
        order.items.len(),
        total_cents,
        order.is_priority(),
        order.flagged_for_review
    )
}

pub fn build_failure_message(order: &Order, reason: &str) -> String {
    format!(
        "order {} for customer {} failed because {}",
        order.id, order.customer_id, reason
    )
}

pub fn notify_order_processed(
    notifier: &mut impl Notifier,
    order: &Order,
    total_cents: u64,
) -> Result<(), String> {
    let subject = format!("Order {} processed", order.id);
    let body = build_order_summary(order, total_cents);
    notifier.send(&subject, &body)
}

pub fn notify_low_inventory(
    notifier: &mut impl Notifier,
    warehouse: &Warehouse,
    sku: &str,
) -> Result<(), String> {
    let subject = format!("Low inventory for {sku}");
    let body = format!(
        "warehouse={} remaining_units={}",
        warehouse.location_code,
        warehouse.inventory_for(sku)
    );

    notifier.send(&subject, &body)
}
