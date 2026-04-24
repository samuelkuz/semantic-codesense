use std::collections::HashMap;

use crate::domain::{Order, OrderStatus};

pub trait OrderRepository {
    fn save(&mut self, order: Order);
    fn get_by_id(&self, id: &str) -> Option<&Order>;
    fn mark_status(&mut self, id: &str, status: OrderStatus) -> bool;
    fn append_audit(&mut self, id: &str, entry: String) -> bool;
}

#[derive(Debug, Default)]
pub struct InMemoryOrderRepository {
    pub orders: HashMap<String, Order>,
}

impl InMemoryOrderRepository {
    pub fn new() -> Self {
        Self::default()
    }
}

impl OrderRepository for InMemoryOrderRepository {
    fn save(&mut self, order: Order) {
        self.orders.insert(order.id.clone(), order);
    }

    fn get_by_id(&self, id: &str) -> Option<&Order> {
        self.orders.get(id)
    }

    fn mark_status(&mut self, id: &str, status: OrderStatus) -> bool {
        if let Some(order) = self.orders.get_mut(id) {
            order.status = status;
            return true;
        }

        false
    }

    fn append_audit(&mut self, id: &str, entry: String) -> bool {
        if let Some(order) = self.orders.get_mut(id) {
            order.audit_log.push(entry);
            return true;
        }

        false
    }
}
