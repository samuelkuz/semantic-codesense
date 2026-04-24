# Test Rust Code

This crate is a compact evaluation corpus for the Semantic CodeSense extension.

It is intentionally structured to give the analysis pipeline useful symbol relationships:

- target definitions with helper chains
- traits and impl blocks
- cross-module callers and callees
- field access and mutable state updates
- side effects through persistence and notifications
- a mix of documented and undocumented functions

## Suggested Eval Targets

- `services::OrderProcessor::process_order`
- `services::OrderProcessor::finalize_order`
- `services::OrderProcessor::handle_failure`
- `pricing::compute_order_total`
- `pricing::requires_manual_review`
- `notifications::notify_order_processed`
- `repository::InMemoryOrderRepository::append_audit`
- `domain::Order::is_priority`

## Deliberate Multi-Hop Targets

These are intentionally thin wrappers or indirection-heavy symbols that should often trigger a second retrieval pass:

- `review::should_queue_manual_review`
- `review::build_review_digest`
- `review::select_review_lane`
- `routing::route_fulfillment_lane`
- `routing::recommended_ops_queue`

## Module Layout

- `domain.rs`: core order, item, and warehouse types
- `pricing.rs`: pricing logic and review heuristics
- `review.rs`: trait-driven review classification and thin review wrappers
- `notifications.rs`: notification trait plus rendering helpers
- `repository.rs`: repository trait and in-memory persistence
- `routing.rs`: fulfillment lane selection with policy and snapshot types
- `services.rs`: orchestration flow with side effects

The crate now includes roughly 45 meaningful functions and methods across these modules.
