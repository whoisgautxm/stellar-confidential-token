//! Bridge between Soroban U256 points and guest `baby-jubjub` curve math.

use baby_jubjub::{self, Egct as GuestEgct, Fp, Point as GuestPoint};
use eerc_types::{Egct, Point};
use soroban_sdk::{Env, U256};

pub fn point_to_guest(p: &Point) -> GuestPoint {
    GuestPoint {
        x: Fp::from_be_bytes32(u256_to_bytes32(&p.x)),
        y: Fp::from_be_bytes32(u256_to_bytes32(&p.y)),
    }
}

pub fn point_from_guest(p: GuestPoint, env: &Env) -> Point {
    Point {
        x: bytes32_to_u256(env, p.x.to_be_bytes32()),
        y: bytes32_to_u256(env, p.y.to_be_bytes32()),
    }
}

pub fn egct_to_guest(e: &Egct) -> GuestEgct {
    GuestEgct {
        c1: point_to_guest(&e.c1),
        c2: point_to_guest(&e.c2),
    }
}

pub fn egct_from_guest(e: GuestEgct, env: &Env) -> Egct {
    Egct {
        c1: point_from_guest(e.c1, env),
        c2: point_from_guest(e.c2, env),
    }
}

pub fn add(a: &Egct, b: &Egct, env: &Env) -> Egct {
    let ga = egct_to_guest(a);
    let gb = egct_to_guest(b);
    egct_from_guest(
        GuestEgct {
            c1: baby_jubjub::add(ga.c1, gb.c1),
            c2: baby_jubjub::add(ga.c2, gb.c2),
        },
        env,
    )
}

pub fn sub(a: &Egct, b: &Egct, env: &Env) -> Egct {
    let ga = egct_to_guest(a);
    let gb = egct_to_guest(b);
    egct_from_guest(
        GuestEgct {
            c1: baby_jubjub::sub(ga.c1, gb.c1),
            c2: baby_jubjub::sub(ga.c2, gb.c2),
        },
        env,
    )
}

pub fn encrypt(public_key: &Point, amount: U256, env: &Env) -> Egct {
    let pk = point_to_guest(public_key);
    let msg = Fp::from_be_bytes32(u256_to_bytes32(&amount));
    egct_from_guest(baby_jubjub::encrypt(pk, msg), env)
}

fn u256_to_bytes32(v: &U256) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = v.to_be_bytes();
    for i in 0..32 {
        out[i] = bytes.get(i as u32).unwrap_or(0);
    }
    out
}

fn bytes32_to_u256(env: &Env, bytes: [u8; 32]) -> U256 {
    U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &bytes))
}
