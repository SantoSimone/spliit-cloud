-- Fractional item quantities: reinterpret `ExpenseItem.quantity` as
-- milli-units (see `QUANTITY_SCALE` in `packages/domain/src/quantity.ts`).
-- Whole quantities scale exactly (`2` → `2000`); fractional quantities did
-- not exist before this migration, so every legacy value is a whole number.
--
-- Deliberately NOT touched:
--   * `amount` — for whole-unit quantities the line amount is invariant
--     (`unitPrice * qty` = `unitPrice * qtyMilli / 1000`), so scaling it
--     would inflate every line 1000×. Post-migration invariant (exact integer
--     division, no rounding involved):
--       SELECT count(*) FROM "ExpenseItem"
--       WHERE "amount" != (("unitPrice" * "quantity") / 1000);
--     must return 0.
--   * `unitPrice` — minor-unit money, unrelated to this change.
--
-- Rerun safety: Prisma applies each migration exactly once (tracked in
-- `_prisma_migrations`). This statement is NOT idempotent — re-running it
-- would scale twice — so never re-apply it manually.
UPDATE "ExpenseItem" SET "quantity" = "quantity" * 1000;

-- Recurring templates embed whole-unit quantities in `template->'items'`
-- (see `buildRecurringTemplate`); scale them identically so future
-- occurrences materialize the same quantities. `amount` fields inside the
-- template are invariant for the same reason as above and stay untouched.
-- Templates without an items array, and items whose quantity is not a JSON
-- number, are left alone rather than failing the migration.
UPDATE "RecurringExpenseSeries"
SET "template" = jsonb_set(
  "template",
  '{items}',
  COALESCE(
    (
      SELECT jsonb_agg(
        CASE
          WHEN jsonb_typeof(elem -> 'quantity') = 'number'
            THEN jsonb_set(
              elem,
              '{quantity}',
              to_jsonb((elem ->> 'quantity')::bigint * 1000)
            )
          ELSE elem
        END
        -- Array order is significant (occurrences materialize items in
        -- array order), so preserve it explicitly.
        ORDER BY ord
      )
      FROM jsonb_array_elements("template" -> 'items')
        WITH ORDINALITY AS elem(elem, ord)
    ),
    '[]'::jsonb
  )
)
WHERE jsonb_typeof("template" -> 'items') = 'array';
