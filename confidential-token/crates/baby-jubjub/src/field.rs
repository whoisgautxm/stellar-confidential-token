use ff::{Field, PrimeField};

#[derive(PrimeField)]
#[PrimeFieldModulus = "21888242871839275222246405745257275088548364400416034343698204186575808495617"]
#[PrimeFieldGenerator = "5"]
#[PrimeFieldReprEndianness = "big"]
pub struct Fp([u64; 4]);

impl Fp {
    pub fn from_u128(v: u128) -> Self {
        let mut bytes = [0u8; 32];
        bytes[24..32].copy_from_slice(&(v as u64).to_be_bytes());
        bytes[16..24].copy_from_slice(&((v >> 64) as u64).to_be_bytes());
        Self::from_be_bytes32(bytes)
    }

    pub fn from_be_bytes32(bytes: [u8; 32]) -> Self {
        let mut repr = <Self as PrimeField>::Repr::default();
        repr.0.copy_from_slice(&bytes);
        Self::from_repr(repr).unwrap_or(Self::ZERO)
    }

    pub fn to_be_bytes32(self) -> [u8; 32] {
        self.to_repr().0
    }
}
