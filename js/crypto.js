/**
 * crypto.js — Sixel 文件加密/解密
 *
 * 使用 AES-256-GCM + PBKDF2 实现 Sixel 数据的认证加密。
 * 加密文件格式: Magic("SXL1") + Salt(16B) + IV(12B) + Ciphertext + AuthTag(16B)
 */
(function () {
    'use strict';

    var MAGIC = new Uint8Array([0x53, 0x58, 0x4C, 0x31]); // "SXL1"
    var SALT_LEN = 16;
    var IV_LEN = 12;
    var HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN; // 32 bytes
    var PBKDF2_ITERATIONS = 100000;

    /**
     * 从密码派生 AES-256 密钥
     */
    function deriveKey(password, salt) {
        var encoder = new TextEncoder();
        return crypto.subtle.importKey(
            'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
        ).then(function (keyMaterial) {
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        });
    }

    /**
     * 加密 Sixel 数据
     * @param {Uint8Array} sixelData - 原始 Sixel 字节
     * @param {string} password - 用户密码
     * @returns {Promise<Uint8Array>} 加密后的数据 (含 header)
     */
    function encryptSixel(sixelData, password) {
        var salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
        var iv = crypto.getRandomValues(new Uint8Array(IV_LEN));

        return deriveKey(password, salt).then(function (key) {
            return crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                sixelData
            );
        }).then(function (encrypted) {
            var encBytes = new Uint8Array(encrypted);
            var result = new Uint8Array(HEADER_LEN + encBytes.length);
            result.set(MAGIC, 0);
            result.set(salt, MAGIC.length);
            result.set(iv, MAGIC.length + SALT_LEN);
            result.set(encBytes, HEADER_LEN);
            return result;
        });
    }

    /**
     * 解密 Sixel 数据
     * @param {Uint8Array} encryptedData - 加密文件字节 (含 header)
     * @param {string} password - 用户密码
     * @returns {Promise<Uint8Array>} 解密后的原始 Sixel 字节
     */
    function decryptSixel(encryptedData, password) {
        // 校验魔数
        if (encryptedData.length < HEADER_LEN + 16) {
            return Promise.reject(new Error('文件过小，不是有效的加密 Sixel 文件'));
        }
        for (var i = 0; i < MAGIC.length; i++) {
            if (encryptedData[i] !== MAGIC[i]) {
                return Promise.reject(new Error('不是加密 Sixel 文件'));
            }
        }

        var salt = encryptedData.slice(MAGIC.length, MAGIC.length + SALT_LEN);
        var iv = encryptedData.slice(MAGIC.length + SALT_LEN, HEADER_LEN);
        var ciphertext = encryptedData.slice(HEADER_LEN);

        return deriveKey(password, salt).then(function (key) {
            return crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                ciphertext
            );
        }).then(function (decrypted) {
            return new Uint8Array(decrypted);
        });
    }

    /**
     * 检测数据是否为加密 Sixel 文件
     * @param {Uint8Array} data - 文件前几字节
     * @returns {boolean}
     */
    function isEncrypted(data) {
        if (data.length < MAGIC.length) return false;
        for (var i = 0; i < MAGIC.length; i++) {
            if (data[i] !== MAGIC[i]) return false;
        }
        return true;
    }

    window.SixelCrypto = {
        encryptSixel: encryptSixel,
        decryptSixel: decryptSixel,
        isEncrypted: isEncrypted
    };
})();
