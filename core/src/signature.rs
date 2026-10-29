//! Release signatures: Ferrite's CI signs each release image `X.btf` with minisign (Ed25519, minisign's default
//! prehashed "ED" signatures) into `X.btf.minisig` beside it. The radio can't check a signature, so Console does.
//!
//! - A signature that verifies with [`FERRITE_PUBLIC_KEY`]: a Ferrite release; its trusted comment says which.
//! - A signature that doesn't (another key, a changed image or signature): refused like a failed image check.
//! - No signature at all: someone's own build (`tools/mkbtf.sh`), allowed and shown as not signed.

use minisign_verify::{Error, PublicKey, Signature};
use serde::Serialize;

/// Ferrite's minisign public key (key ID 5B2C47F45817851B), the base64 line of its `.pub` file.
pub const FERRITE_PUBLIC_KEY: &str = "RWQbhRdY9EcsW+Has6GdiIJMPCVPZltho1Lv4lkOpBYls0fxgxZ6Tvai";

/// What the page shows: `signed` (the trusted comment) when it verified, else `error`.
#[derive(Debug, Serialize)]
pub struct SignatureCheck {
    pub signed: Option<String>,
    pub error: Option<String>,
}

/// An image against its `.minisig` text, with Ferrite's key: the trusted comment, or why it doesn't verify.
pub fn verify(image: &[u8], minisig: &str) -> Result<String, String> {
    verify_with(FERRITE_PUBLIC_KEY, image, minisig)
}

/// [`verify`] as the page takes it.
pub fn check(image: &[u8], minisig: &str) -> SignatureCheck {
    match verify(image, minisig) {
        Ok(c) => SignatureCheck { signed: Some(c), error: None },
        Err(e) => SignatureCheck { signed: None, error: Some(e) },
    }
}

/// [`verify`] with any key (the tests' throwaway one).
pub fn verify_with(public_key: &str, image: &[u8], minisig: &str) -> Result<String, String> {
    let key = PublicKey::from_base64(public_key).map_err(|e| format!("the public key doesn't parse ({e})"))?;
    let sig = Signature::decode(minisig).map_err(|_| "the signature file isn't a minisign signature".to_string())?;
    // Legacy (not prehashed) signatures refused: Ferrite's CI uses minisign's default.
    key.verify(image, &sig, false).map_err(|e| match e {
        Error::UnexpectedKeyId => "the signature is from another key, not Ferrite's".to_string(),
        Error::InvalidSignature => "the signature doesn't match this image (the image or its signature was changed)".to_string(),
        Error::UnexpectedAlgorithm => "a legacy minisign signature: Ferrite's are prehashed (minisign's default)".to_string(),
        e => e.to_string(),
    })?;
    Ok(sig.trusted_comment().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // tests/fixtures/signed-test.*: a throwaway key pair's public key, a small file and its signature
    // (minisign -G -W; minisign -S -t "Ferrite test0000").
    const IMAGE: &[u8] = include_bytes!("../tests/fixtures/signed-test.btf");
    const SIG: &str = include_str!("../tests/fixtures/signed-test.btf.minisig");
    const PUB: &str = include_str!("../tests/fixtures/signed-test.pub");

    fn test_key() -> &'static str {
        PUB.lines().nth(1).unwrap()
    }

    #[test]
    fn ferrite_key_parses() {
        assert!(PublicKey::from_base64(FERRITE_PUBLIC_KEY).is_ok());
    }

    #[test]
    fn good_signature_gives_the_trusted_comment() {
        assert_eq!(verify_with(test_key(), IMAGE, SIG), Ok("Ferrite test0000".to_string()));
    }

    #[test]
    fn a_flipped_image_byte_fails() {
        let mut b = IMAGE.to_vec();
        b[3] ^= 1;
        assert!(verify_with(test_key(), &b, SIG).unwrap_err().contains("doesn't match"));
    }

    #[test]
    fn another_key_fails() {
        // The throwaway key's signature checked against Ferrite's key: refused.
        let e = verify(IMAGE, SIG).unwrap_err();
        assert!(e.contains("another key"), "{e}");
        let c = check(IMAGE, SIG);
        assert!(c.signed.is_none() && c.error.is_some());
    }

    #[test]
    fn a_changed_trusted_comment_fails() {
        let s = SIG.replace("Ferrite test0000", "Ferrite test9999");
        assert!(verify_with(test_key(), IMAGE, &s).is_err());
    }

    #[test]
    fn not_a_signature_fails() {
        assert!(verify_with(test_key(), IMAGE, "hello").unwrap_err().contains("isn't a minisign signature"));
    }
}
