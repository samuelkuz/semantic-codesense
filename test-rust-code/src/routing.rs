use crate::domain::{Order, Warehouse};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FulfillmentLane {
    Standard,
    WhiteGlove,
    ColdChain,
    Hold,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShipmentSnapshot {
    pub cold_chain_required: bool,
    pub destination_zone: String,
    pub reserved_fragile_units: u32,
    pub oversize_units: u32,
    pub backlog_minutes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutingPolicy {
    pub cold_chain_buffer: u32,
    pub fragile_threshold: u32,
    pub hold_zones: Vec<String>,
    pub prefer_white_glove: bool,
}

fn requires_cold_chain(order: &Order, snapshot: &ShipmentSnapshot) -> bool {
    snapshot.cold_chain_required || order.items.iter().any(|item| item.sku.starts_with("COLD-"))
}

fn needs_white_glove(order: &Order, snapshot: &ShipmentSnapshot, policy: &RoutingPolicy) -> bool {
    snapshot.oversize_units > 0
        || policy.prefer_white_glove
            && (snapshot.reserved_fragile_units >= policy.fragile_threshold
                || order.items.iter().any(|item| item.is_fragile()))
}

fn warehouse_pressure_band(warehouse: &Warehouse, snapshot: &ShipmentSnapshot) -> u32 {
    snapshot.backlog_minutes + warehouse.reorder_threshold.saturating_mul(12)
}

fn matches_hold_zone(snapshot: &ShipmentSnapshot, policy: &RoutingPolicy) -> bool {
    policy
        .hold_zones
        .iter()
        .any(|zone| zone == &snapshot.destination_zone)
}

/// Small selector whose final meaning depends on helper logic and policy field roles.
pub fn route_fulfillment_lane(
    order: &Order,
    warehouse: &Warehouse,
    snapshot: &ShipmentSnapshot,
    policy: &RoutingPolicy,
) -> FulfillmentLane {
    if matches_hold_zone(snapshot, policy) || warehouse_pressure_band(warehouse, snapshot) > 90 {
        FulfillmentLane::Hold
    } else if requires_cold_chain(order, snapshot)
        && warehouse.inventory_for("COLD-PACK") <= policy.cold_chain_buffer
    {
        FulfillmentLane::Hold
    } else if requires_cold_chain(order, snapshot) {
        FulfillmentLane::ColdChain
    } else if needs_white_glove(order, snapshot, policy) {
        FulfillmentLane::WhiteGlove
    } else {
        FulfillmentLane::Standard
    }
}

pub fn lane_requires_supervision(lane: &FulfillmentLane, snapshot: &ShipmentSnapshot) -> bool {
    matches!(lane, FulfillmentLane::Hold | FulfillmentLane::WhiteGlove)
        || matches!(lane, FulfillmentLane::ColdChain) && snapshot.backlog_minutes > 45
}

/// Thin wrapper intended to encourage a second pass through lane helper semantics.
pub fn recommended_ops_queue(
    order: &Order,
    warehouse: &Warehouse,
    snapshot: &ShipmentSnapshot,
    policy: &RoutingPolicy,
) -> &'static str {
    let lane = route_fulfillment_lane(order, warehouse, snapshot, policy);

    if lane_requires_supervision(&lane, snapshot) {
        "manual-fulfillment"
    } else if order.is_priority() {
        "priority-pack"
    } else {
        "auto-pack"
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::domain::{CustomerTier, Order, OrderItem, PaymentMethod, Warehouse};

    use super::{
        FulfillmentLane, RoutingPolicy, ShipmentSnapshot, recommended_ops_queue,
        route_fulfillment_lane,
    };

    fn build_order() -> Order {
        let mut order = Order::new(
            "route-1",
            "customer-route",
            CustomerTier::Gold,
            PaymentMethod::Card,
            vec![OrderItem {
                sku: "COLD-KIT".to_string(),
                quantity: 1,
                unit_price_cents: 3_000,
                weight_grams: 200,
                fragile: false,
            }],
        );
        order.notes.push("rush handling".to_string());
        order
    }

    fn build_warehouse(cold_pack_units: u32) -> Warehouse {
        Warehouse {
            location_code: "SLC-2".to_string(),
            inventory: HashMap::from([("COLD-PACK".to_string(), cold_pack_units)]),
            reorder_threshold: 2,
        }
    }

    #[test]
    fn route_lane_holds_when_cold_chain_supplies_are_low() {
        let lane = route_fulfillment_lane(
            &build_order(),
            &build_warehouse(0),
            &ShipmentSnapshot {
                cold_chain_required: true,
                destination_zone: "west".to_string(),
                reserved_fragile_units: 0,
                oversize_units: 0,
                backlog_minutes: 15,
            },
            &RoutingPolicy {
                cold_chain_buffer: 1,
                fragile_threshold: 2,
                hold_zones: vec!["intl".to_string()],
                prefer_white_glove: false,
            },
        );

        assert_eq!(lane, FulfillmentLane::Hold);
    }

    #[test]
    fn recommended_queue_uses_manual_lane_for_supervised_shipments() {
        let queue = recommended_ops_queue(
            &build_order(),
            &build_warehouse(0),
            &ShipmentSnapshot {
                cold_chain_required: true,
                destination_zone: "west".to_string(),
                reserved_fragile_units: 0,
                oversize_units: 0,
                backlog_minutes: 15,
            },
            &RoutingPolicy {
                cold_chain_buffer: 1,
                fragile_threshold: 2,
                hold_zones: vec!["intl".to_string()],
                prefer_white_glove: false,
            },
        );

        assert_eq!(queue, "manual-fulfillment");
    }
}
