use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CustomerTier {
    Standard,
    Gold,
    Platinum,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentMethod {
    Card,
    Invoice,
    WireTransfer,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    Draft,
    PendingPayment,
    Paid,
    Failed,
}

#[derive(Clone, Debug)]
pub struct OrderItem {
    pub sku: String,
    pub quantity: u32,
    pub unit_price_cents: u64,
    pub weight_grams: u32,
    pub fragile: bool,
}

impl OrderItem {
    pub fn subtotal(&self) -> u64 {
        self.unit_price_cents.saturating_mul(self.quantity as u64)
    }

    pub fn is_fragile(&self) -> bool {
        self.fragile || self.sku.starts_with("GLASS-")
    }
}

#[derive(Clone, Debug)]
pub struct Order {
    pub id: String,
    pub customer_id: String,
    pub tier: CustomerTier,
    pub payment_method: PaymentMethod,
    pub items: Vec<OrderItem>,
    pub notes: Vec<String>,
    pub audit_log: Vec<String>,
    pub status: OrderStatus,
    pub receipt_code: Option<String>,
    pub flagged_for_review: bool,
}

impl Order {
    pub fn new(
        id: impl Into<String>,
        customer_id: impl Into<String>,
        tier: CustomerTier,
        payment_method: PaymentMethod,
        items: Vec<OrderItem>,
    ) -> Self {
        Self {
            id: id.into(),
            customer_id: customer_id.into(),
            tier,
            payment_method,
            items,
            notes: Vec::new(),
            audit_log: vec!["order created".to_string()],
            status: OrderStatus::PendingPayment,
            receipt_code: None,
            flagged_for_review: false,
        }
    }

    pub fn subtotal(&self) -> u64 {
        self.items.iter().map(OrderItem::subtotal).sum()
    }

    pub fn is_priority(&self) -> bool {
        matches!(self.tier, CustomerTier::Platinum)
            || self.items.iter().any(OrderItem::is_fragile)
            || self
                .notes
                .iter()
                .any(|note| note.to_ascii_lowercase().contains("rush"))
    }

    pub fn mark_paid(&mut self, receipt_code: String) {
        self.status = OrderStatus::Paid;
        self.audit_log
            .push(format!("payment settled with receipt {receipt_code}"));
        self.receipt_code = Some(receipt_code);
    }
}

#[derive(Clone, Debug)]
pub struct Warehouse {
    pub location_code: String,
    pub inventory: HashMap<String, u32>,
    pub reorder_threshold: u32,
}

impl Warehouse {
    pub fn inventory_for(&self, sku: &str) -> u32 {
        self.inventory.get(sku).copied().unwrap_or(0)
    }

    pub fn is_low_stock(&self, sku: &str) -> bool {
        self.inventory_for(sku) <= self.reorder_threshold
    }
}
