let items = Object.create(null);
let firstItemDate;

export function itemsPoolLength() {
  return Object.keys(items).length;
}

export function addItem(key, item) {
  if (itemsPoolLength() === 0) {
    firstItemDate = Date.now();
  }
  if (items[key]) {
    return false;
  }
  items[key] = item;
  return true;
}

export function getItemsAge() {
  return firstItemDate ? Date.now() - firstItemDate : 0;
}

export function getAllMemPoolItems() {
  const currentItems = { ...items };
  items = Object.create(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  firstItemDate = undefined;
  return currentItems;
}
