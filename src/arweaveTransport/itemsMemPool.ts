let items = Object.create(null);
let firstItemDate;

export function itemsPoolLength() {
  return Object.keys(items).length;
}

export function addItem(key, item) {
  if (itemsPoolLength() === 0) {
    firstItemDate = Date.now();
  }
  items[key] = item;
}

export function getItemsAge() {
  return Date.now() - firstItemDate;
}

export function getAllMemPoolItems() {
  const currentItems = { ...items };
  items = Object.create(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  firstItemDate = undefined;
  return currentItems;
}
