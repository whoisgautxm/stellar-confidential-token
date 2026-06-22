use crate::field::Fp;
use ff::{Field, PrimeField};

pub const BASE_POINT_ORDER: [u8; 32] = [
    0x06, 0x0c, 0x89, 0xce, 0x5c, 0x26, 0x34, 0x05, 0x37, 0x0a, 0x08, 0xb6, 0xd0, 0x30, 0x2b, 0x0b,
    0xab, 0x3e, 0xed, 0xb8, 0x39, 0x20, 0xee, 0x0a, 0x67, 0x72, 0x97, 0xdc, 0x39, 0x21, 0x26, 0xf1,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: Fp,
    pub y: Fp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Egct {
    pub c1: Point,
    pub c2: Point,
}

pub fn base8() -> Point {
    Point {
        x: Fp::from_be_bytes32([
            0x0b, 0xb7, 0x7a, 0x6a, 0xd6, 0x3e, 0x73, 0x9b, 0x4e, 0xac, 0xb2, 0xe0, 0x9d, 0x62, 0x77,
            0xc1, 0x2a, 0xb8, 0xd8, 0x01, 0x05, 0x34, 0xe0, 0xb6, 0x28, 0x93, 0xf3, 0xf6, 0xbb, 0x95,
            0x70, 0x51,
        ]),
        y: Fp::from_be_bytes32([
            0x25, 0x79, 0x72, 0x03, 0xf7, 0xa0, 0xb2, 0x49, 0x25, 0x57, 0x2e, 0x1c, 0xd1, 0x6b, 0xf9,
            0xed, 0xfc, 0xe0, 0x05, 0x1f, 0xb9, 0xe1, 0x33, 0x77, 0x4b, 0x3c, 0x25, 0x7a, 0x87, 0x2d,
            0x7d, 0x8b,
        ]),
    }
}

pub fn negate(p: Point) -> Point {
    Point { x: -p.x, y: p.y }
}

pub fn add(p1: Point, p2: Point) -> Point {
    let a_coeff = Fp::from_u128(168700);
    let d_coeff = Fp::from_u128(168696);

    let x1x2 = p1.x * p2.x;
    let y1y2 = p1.y * p2.y;
    let dx1x2y1y2 = d_coeff * x1x2 * y1y2;

    let x3_num = p1.x * p2.y + p1.y * p2.x;
    let y3_num = y1y2 - a_coeff * x1x2;

    let x3 = x3_num * (Fp::ONE + dx1x2y1y2).invert().unwrap();
    let y3 = y3_num * (Fp::ONE - dx1x2y1y2).invert().unwrap();

    Point { x: x3, y: y3 }
}

pub fn sub(p1: Point, p2: Point) -> Point {
    add(p1, negate(p2))
}

pub fn double(p: Point) -> Point {
    add(p, p)
}

pub fn scalar_mul(point: Point, scalar_bytes: [u8; 32]) -> Point {
    let order = Fp::from_be_bytes32(BASE_POINT_ORDER);
    let mut remaining = Fp::from_be_bytes32(scalar_bytes);
    while remaining >= order {
        remaining -= order;
    }

    let mut result = Point {
        x: Fp::ZERO,
        y: Fp::ONE,
    };
    let mut base = point;
    let repr = remaining.to_repr();

    for limb in repr.0.chunks(8) {
        let mut val = 0u64;
        for (i, b) in limb.iter().enumerate() {
            val |= (*b as u64) << (56 - i * 8);
        }
        for bit in 0..64u64 {
            if (val >> bit) & 1 == 1 {
                result = add(result, base);
            }
            base = double(base);
        }
    }
    result
}

/// On-chain deposit encryption uses fixed randomness r = 1 (matches eERC BabyJubJub.sol).
pub fn encrypt(public_key: Point, msg: Fp) -> Egct {
    let random = Fp::ONE;
    let b8 = base8();
    let c1 = scalar_mul(b8, random.to_be_bytes32());
    let pkr = scalar_mul(public_key, random.to_be_bytes32());
    let p_msg = scalar_mul(b8, msg.to_be_bytes32());
    let c2 = add(pkr, p_msg);
    Egct { c1, c2 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base8_is_on_curve() {
        let b = base8();
        let a = Fp::from_u128(168700);
        let d = Fp::from_u128(168696);
        let lhs = a * b.x * b.x + b.y * b.y;
        let rhs = Fp::ONE + d * b.x * b.x * b.y * b.y;
        assert_eq!(lhs, rhs);
    }

    #[test]
    fn add_then_sub_restores_point() {
        let g = base8();
        let p = scalar_mul(g, Fp::from_u128(7).to_be_bytes32());
        let q = scalar_mul(g, Fp::from_u128(11).to_be_bytes32());
        let sum = add(p, q);
        let back = sub(sum, q);
        assert_eq!(back, p);
    }
}
