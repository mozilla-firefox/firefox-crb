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

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
];
const BECH32_CONSTANT = 1;
const BECH32M_CONSTANT = 0x2bc830a3;

/**
 * Bech32 (BIP 173) or Bech32m (BIP 350) checksum of a "bc1..." Bitcoin
 * address. Either constant is accepted for any witness version, which is
 * looser than the spec but enough to tell an address from a look-alike.
 *
 * @param {string} address
 * @returns {boolean}
 */
export function bech32(address) {
  const lower = address.toLowerCase();
  if (lower !== address && address.toUpperCase() !== address) {
    return false;
  }
  const separator = lower.lastIndexOf("1");
  if (separator < 1 || separator + 7 > lower.length) {
    return false;
  }
  const prefix = [...lower.slice(0, separator)].map(char => char.charCodeAt(0));
  const data = [];
  for (const char of lower.slice(separator + 1)) {
    const index = BECH32_ALPHABET.indexOf(char);
    if (index < 0) {
      return false;
    }
    data.push(index);
  }
  let checksum = 1;
  const values = [
    ...prefix.map(code => code >> 5),
    0,
    ...prefix.map(code => code & 31),
    ...data,
  ];
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) {
        checksum ^= BECH32_GENERATOR[i];
      }
    }
  }
  return checksum === BECH32_CONSTANT || checksum === BECH32M_CONSTANT;
}
