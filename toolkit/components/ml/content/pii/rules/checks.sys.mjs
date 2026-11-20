/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * @param {string} digits - ASCII digits only.
 * @returns {boolean} Whether the last digit is the Luhn check digit.
 */
export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * ISO 13616 mod-97 check of an IBAN.
 *
 * @param {string} iban - Upper case, without spaces.
 * @returns {boolean}
 */
export function mod97(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value =
      char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/** @type {nsICryptoHash} */
let hash;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function sha256(bytes) {
  // One instance, initialized again for each hash: creating one per call
  // costs more than the hash itself.
  hash ??= Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(bytes, bytes.length);
  return Uint8Array.from(hash.finish(false), char => char.charCodeAt(0));
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58Check checksum of a legacy or P2SH Bitcoin address.
 *
 * @param {string} address
 * @returns {boolean}
 */
export function base58check(address) {
  // Base58 to bytes: multiply the bytes so far by 58 and add each digit.
  /** @type {number[]} */
  const bytes = [];
  for (const char of address) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) {
      return false;
    }
    for (let i = bytes.length - 1; i >= 0; i--) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of address) {
    if (char !== "1") {
      break;
    }
    bytes.unshift(0);
  }
  if (bytes.length < 5) {
    return false;
  }
  const payload = Uint8Array.from(bytes.slice(0, -4));
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return checksum.every((byte, i) => byte === bytes[bytes.length - 4 + i]);
}
