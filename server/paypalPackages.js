/**
 * Server-authoritative PayPal ticket packages.
 * Clients may only submit packageId; never trust client prices or ticket counts.
 */

const PACKAGES = Object.freeze({
  pack_5: Object.freeze({
    id: "pack_5",
    label: "20 tickets",
    amountValue: "5.00",
    currency: "USD",
    tickets: 20,
  }),
  pack_20: Object.freeze({
    id: "pack_20",
    label: "100 tickets",
    amountValue: "20.00",
    currency: "USD",
    tickets: 100,
  }),
  pack_50: Object.freeze({
    id: "pack_50",
    label: "300 tickets",
    amountValue: "50.00",
    currency: "USD",
    tickets: 300,
  }),
});

export function listPaypalPackages() {
  return Object.values(PACKAGES);
}

export function getPaypalPackage(packageId) {
  const id = String(packageId || "").trim();
  return PACKAGES[id] || null;
}
