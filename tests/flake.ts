import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Flake } from "../target/types/flake";
import { expect } from "chai";

describe("factory", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Flake as Program<Flake>;
  const owner = anchor.web3.Keypair.generate();

  let factoryAccount: anchor.web3.Keypair;
  let pairAddress: anchor.web3.PublicKey;
  let tokenA: anchor.web3.PublicKey;
  let tokenB: anchor.web3.PublicKey;

  before(async () => {
    const signature = await anchor.getProvider().connection.requestAirdrop(
      owner.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await anchor.getProvider().connection.confirmTransaction(signature);
  });

  it("Initializes factory", async () => {
    factoryAccount = anchor.web3.Keypair.generate();

    await program.methods
      .initialize()
      .accounts({
        factory: factoryAccount.publicKey,
        owner: owner.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([factoryAccount, owner])
      .rpc();

    const factory = await program.account.factory.fetch(factoryAccount.publicKey);
    expect(factory.owner.toString()).to.equal(owner.publicKey.toString());
    expect(factory.pairCount.toNumber()).to.equal(0);
  });

  it("Creates a pair", async () => {
    tokenA = anchor.web3.Keypair.generate().publicKey;
    tokenB = anchor.web3.Keypair.generate().publicKey;

    const [_pairAddress, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("pair"),
        tokenA.toBytes(),
        tokenB.toBytes(),
      ],
      program.programId
    );
    pairAddress = _pairAddress;

    await program.methods
      .createPair(tokenA, tokenB, bump)
      .accounts({
        factory: factoryAccount.publicKey,
        pair: pairAddress,
        payer: owner.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const pair = await program.account.pair.fetch(pairAddress);
    expect(pair.tokenA.toString()).to.equal(tokenA.toString());
    expect(pair.tokenB.toString()).to.equal(tokenB.toString());
    expect(pair.authority.toString()).to.equal(factoryAccount.publicKey.toString());
    expect(pair.bump).to.equal(bump);
    expect(pair.reserveA.toNumber()).to.equal(0);
    expect(pair.reserveB.toNumber()).to.equal(0);
  });

  it("Fails to swap with no liquidity", async () => {
    try {
      await program.methods
        .swap(new anchor.BN(100), new anchor.BN(90))
        .accounts({
          pair: pairAddress,
          tokenIn: tokenA,
          tokenOut: tokenB,
          user: owner.publicKey,
        })
        .signers([owner])
        .rpc();
      expect.fail("Expected the swap to fail");
    } catch (error) {
      expect(error.message).to.include("InsufficientLiquidity");
    }
  });
});