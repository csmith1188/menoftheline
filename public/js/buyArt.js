const BUY_BG_SRC = {
  troop: "/img/troop_red.svg",
  skirmisher: "/img/skirmisher_red.svg",
  dragoon: "/img/dragoon_red.svg",
  cannon: "/img/guns_red.svg",
  officer: "/img/officer_red.svg",
};

const buyBgImages = {};

/** Public path for buy-button SVG art, or null. */
export function buyBgSrc(type) {
  return BUY_BG_SRC[type] || null;
}

/** Buy-button art for a unit type. Null until the image is ready. */
export function buyBgImage(type) {
  const src = buyBgSrc(type);
  if (!src) return null;
  let img = buyBgImages[type];
  if (!img) {
    img = new Image();
    img.src = src;
    buyBgImages[type] = img;
  }
  if (!img.complete || img.naturalWidth <= 0) return null;
  return img;
}
