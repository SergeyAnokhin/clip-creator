/** Pure helper for ordering a wish library's chips by how often each one has
 * been toggled on (`use_count`, bumped by useSettings.js's bumpWishUse/
 * bumpSceneWishUse/bumpTitleCardWishUse) - most-used first. Missing/undefined
 * `use_count` (older wishes, added before this field existed) sorts as 0.
 * `Array.prototype.sort` is stable, so wishes with equal counts keep their
 * existing (add-order) relative position. */
export function sortByUseCount(wishes) {
  return [...(wishes || [])].sort((a, b) => (b.use_count || 0) - (a.use_count || 0));
}
