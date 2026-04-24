use crate::domain::{CustomerTier, Order, PaymentMethod, Warehouse};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewDecision {
    pub risk_score: u32,
    pub requires_manager: bool,
    pub hold_reason: Option<String>,
    pub watch_channels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscalationPolicy {
    pub invoice_review_floor_cents: u64,
    pub fragile_watch_limit: u32,
    pub vip_score_bonus: u32,
    pub blocked_terms: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpsProfile {
    pub expedite_threshold: u32,
    pub finance_channel_enabled: bool,
    pub fallback_lane: String,
}

pub trait ReviewPlanner {
    fn classify(&self, order: &Order, warehouse: &Warehouse) -> ReviewDecision;
}

#[derive(Clone, Debug)]
pub struct WeightedReviewPlanner {
    pub policy: EscalationPolicy,
}

impl WeightedReviewPlanner {
    pub fn new(policy: EscalationPolicy) -> Self {
        Self { policy }
    }

    fn score_payment_risk(&self, order: &Order) -> u32 {
        match order.payment_method {
            PaymentMethod::Card => 10,
            PaymentMethod::Invoice
                if order.subtotal() >= self.policy.invoice_review_floor_cents =>
            {
                55
            }
            PaymentMethod::Invoice => 25,
            PaymentMethod::WireTransfer => 40,
        }
    }

    fn score_inventory_pressure(&self, order: &Order, warehouse: &Warehouse) -> u32 {
        order
            .items
            .iter()
            .map(|item| {
                let remaining_units = warehouse.inventory_for(&item.sku);

                if remaining_units <= warehouse.reorder_threshold {
                    30
                } else if item.is_fragile() && remaining_units <= self.policy.fragile_watch_limit {
                    20
                } else {
                    0
                }
            })
            .sum()
    }

    fn contains_sensitive_note(&self, order: &Order) -> bool {
        order.notes.iter().any(|note| {
            let lowered = note.to_ascii_lowercase();
            self.policy
                .blocked_terms
                .iter()
                .any(|term| lowered.contains(&term.to_ascii_lowercase()))
        })
    }

    fn derive_watch_channels(&self, order: &Order, inventory_pressure: u32) -> Vec<String> {
        let mut channels = Vec::new();

        if matches!(
            order.payment_method,
            PaymentMethod::Invoice | PaymentMethod::WireTransfer
        ) {
            channels.push("finance".to_string());
        }

        if inventory_pressure > 0 {
            channels.push("warehouse".to_string());
        }

        if matches!(order.tier, CustomerTier::Platinum) {
            channels.push("vip".to_string());
        }

        channels
    }
}

impl ReviewPlanner for WeightedReviewPlanner {
    fn classify(&self, order: &Order, warehouse: &Warehouse) -> ReviewDecision {
        let inventory_pressure = self.score_inventory_pressure(order, warehouse);
        let mut risk_score = self.score_payment_risk(order) + inventory_pressure;

        if matches!(order.tier, CustomerTier::Platinum) {
            risk_score += self.policy.vip_score_bonus;
        }

        if self.contains_sensitive_note(order) {
            risk_score += 25;
        }

        let hold_reason = if inventory_pressure >= 40 {
            Some("inventory pressure crossed review threshold".to_string())
        } else if self.contains_sensitive_note(order) {
            Some("order notes matched a blocked term".to_string())
        } else {
            None
        };

        ReviewDecision {
            risk_score,
            requires_manager: risk_score >= 80,
            hold_reason,
            watch_channels: self.derive_watch_channels(order, inventory_pressure),
        }
    }
}

/// Thin wrapper intended to force follow-up retrieval into planner trait behavior.
pub fn should_queue_manual_review(
    order: &Order,
    warehouse: &Warehouse,
    planner: &impl ReviewPlanner,
) -> bool {
    let decision = planner.classify(order, warehouse);
    decision.requires_manager || decision.hold_reason.is_some()
}

/// Small lane selector whose field semantics are clearer after type and usage retrieval.
pub fn select_review_lane(decision: &ReviewDecision, profile: &OpsProfile) -> String {
    if decision.requires_manager {
        "senior-ops".to_string()
    } else if decision.risk_score >= profile.expedite_threshold {
        "rapid-review".to_string()
    } else if decision
        .watch_channels
        .iter()
        .any(|channel| channel == "finance")
        && profile.finance_channel_enabled
    {
        "finance-desk".to_string()
    } else {
        profile.fallback_lane.clone()
    }
}

/// Multi-hop symbol that combines trait behavior, helper logic, and field roles.
pub fn build_review_digest(
    order: &Order,
    warehouse: &Warehouse,
    planner: &impl ReviewPlanner,
    profile: &OpsProfile,
) -> String {
    let decision = planner.classify(order, warehouse);
    let lane = select_review_lane(&decision, profile);

    format!(
        "order={} lane={} score={} hold={} channels={}",
        order.id,
        lane,
        decision.risk_score,
        decision.hold_reason.as_deref().unwrap_or("none"),
        decision.watch_channels.join("|")
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::domain::{CustomerTier, Order, OrderItem, PaymentMethod, Warehouse};

    use super::{
        EscalationPolicy, OpsProfile, WeightedReviewPlanner, build_review_digest,
        should_queue_manual_review,
    };

    fn build_order() -> Order {
        let mut order = Order::new(
            "review-1",
            "customer-review",
            CustomerTier::Platinum,
            PaymentMethod::Invoice,
            vec![OrderItem {
                sku: "GLASS-LAMP".to_string(),
                quantity: 2,
                unit_price_cents: 9_500,
                weight_grams: 800,
                fragile: true,
            }],
        );
        order.notes.push("manual customs hold".to_string());
        order
    }

    fn build_warehouse() -> Warehouse {
        Warehouse {
            location_code: "DEN-3".to_string(),
            inventory: HashMap::from([("GLASS-LAMP".to_string(), 1)]),
            reorder_threshold: 1,
        }
    }

    fn build_planner() -> WeightedReviewPlanner {
        WeightedReviewPlanner::new(EscalationPolicy {
            invoice_review_floor_cents: 10_000,
            fragile_watch_limit: 2,
            vip_score_bonus: 20,
            blocked_terms: vec!["manual".to_string(), "customs".to_string()],
        })
    }

    #[test]
    fn queue_manual_review_for_high_risk_order() {
        assert!(should_queue_manual_review(
            &build_order(),
            &build_warehouse(),
            &build_planner()
        ));
    }

    #[test]
    fn build_review_digest_includes_selected_lane() {
        let digest = build_review_digest(
            &build_order(),
            &build_warehouse(),
            &build_planner(),
            &OpsProfile {
                expedite_threshold: 65,
                finance_channel_enabled: true,
                fallback_lane: "triage".to_string(),
            },
        );

        assert!(digest.contains("lane=senior-ops"));
    }
}
