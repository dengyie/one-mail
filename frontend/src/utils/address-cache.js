// LocalAddressCache is an in-browser cache of address JWTs used by
// AddressSelect.vue (useLocalStorage('LocalAddressCache', [])) so frequently
// used addresses do not require re-login. It lives outside the global store,
// so the three logout handlers must clear it explicitly — otherwise a shared
// device keeps the cached credentials after logout.

export const LOCAL_ADDRESS_CACHE_KEY = 'LocalAddressCache';

export function clearLocalAddressCache() {
  try {
    localStorage.removeItem(LOCAL_ADDRESS_CACHE_KEY);
  } catch (error) {
    // Private-mode storage failures must not break logout.
    console.warn('[address-cache] failed to clear local address cache', error);
  }
}