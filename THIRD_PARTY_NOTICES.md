# Third-party notices

## Lucide icons

The refresh and copy action icon geometry is adapted from Lucide.

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## Package license inventory

The package command appends exact upstream LICENSE/NOTICE/COPYING texts for every package in the esbuild input graph, including SDK-specific versions, and retains source copyright notices. The generated THIRD_PARTY_INVENTORY.json lists the included package versions. The following supplemental attributions cover embedded implementations.

## QR encoder/decoder upstream attribution


Copyright (c) 2023 Paul Miller (paulmillr.com)

Copyright (c) 2019 ZXing authors

The library paulmillr-qr is dual-licensed under the Apache 2.0 OR MIT license.
You can select a license of your choice.

The library contains code inspired by [ZXing](https://github.com/zxing/zxing), which is licensed under Apache 2.0.

The license to the use of the QR Code stipulated by JIS (Japanese Industrial Standards) and the ISO are not necessary.
The specification for QR Code has been made available for use by any person or organization. (Obtaining QR Code Specification)
The word “QR Code” is registered trademark of DENSO WAVE INCORPORATED in Japan and other countries.
To use the word “QR Code” in your publications or web site, etc, please indicate a sentence QR Code is registered trademark of DENSO WAVE INCORPORATED.
This registered trademark applies only for the word “QR Code”, and not for the QR Code pattern (image).
(https://www.qrcode.com/en/faq.html)


## hash-wasm embedded implementations

Argon2 and BLAKE2b are embedded WASM used by the wallet's Argon2id KDF. Their source headers are retained below. For BLAKE2b, distribution uses the Apache-2.0 option; its full license text is also included in the generated qr LICENSE section.

### argon2.c

/*
  Based on Golang's Argon2 implementation from crypto package

  Written for hash-wasm by Dani Biró
*/

### blake2b.c

/*
  BLAKE2 reference source code package - reference C implementations
  Copyright 2012, Samuel Neves <sneves@dei.uc.pt>.  You may use this under the
  terms of the CC0, the OpenSSL Licence, or the Apache Public License 2.0, at
  your option.  The terms of these licenses can be found at:
  - CC0 1.0 Universal : http://creativecommons.org/publicdomain/zero/1.0
  - OpenSSL license   : https://www.openssl.org/source/license.html
  - Apache 2.0        : http://www.apache.org/licenses/LICENSE-2.0

  More information about the BLAKE2 hash function can be found at
  https://blake2.net.

  Modified for hash-wasm by Dani Biró
*/

### Go crypto reference license

The Argon2 source above identifies Go crypto as its reference. License source: https://github.com/golang/crypto/blob/master/LICENSE

Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
