import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Flake } from "../target/types/flake";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getMint
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";

describe("factory", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Flake as Program<Flake>;
  
  const creator = (program.provider as anchor.AnchorProvider).wallet;
  const user = anchor.web3.Keypair.generate();
  const feeRecipient = anchor.web3.Keypair.generate();
  let factoryAccount: anchor.web3.Keypair;
  let pairAddress: anchor.web3.PublicKey;
  let vaultAddress: anchor.web3.PublicKey;
  let mintKeypair: anchor.web3.Keypair;
  let userATA: anchor.web3.PublicKey;
  let creatorATA: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to user for transactions
    const signature = await program.provider.connection.requestAirdrop(
      user.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await program.provider.connection.confirmTransaction(signature);
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  it("Initializes factory", async () => {
    factoryAccount = anchor.web3.Keypair.generate();
    
    await program.methods
      .initializeFactory(new BN(100))
      .accounts({
        factory: factoryAccount.publicKey,
        feeRecipient: feeRecipient.publicKey,
        authority: creator.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([factoryAccount])
      .rpc();

    const factory = await program.account.factory.fetch(factoryAccount.publicKey);
    expect(factory.authority.toString()).to.equal(creator.publicKey.toString());
    expect(factory.pairsCount.toNumber()).to.equal(0);
  });

  it("Creates a pair with attention token", async () => {
    mintKeypair = anchor.web3.Keypair.generate();
    const pairsCount = new BN(0);

    // 1. Get PDAs
    [pairAddress] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("pair"),
        creator.publicKey.toBuffer(),
        pairsCount.toArrayLike(Buffer, "le", 8)
      ],
      program.programId
    );

    [vaultAddress] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        pairAddress.toBuffer(),
      ],
      program.programId
    );

    // 2. Get ATA address (but don't create yet)
    creatorATA = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      creator.publicKey
    );

    // 3. Create mint account (only space allocation)
    const mintRent = await program.provider.connection.getMinimumBalanceForRentExemption(82);
    const createMintAccountIx = anchor.web3.SystemProgram.createAccount({
      fromPubkey: creator.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: 82,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    });

    const params = {
      name: "Creator Token",
      ticker: "CTKN",
      description: "Test token description",
      tokenImage: "https://example.com/image.png",
      twitter: "@creator",
      telegram: "@creator",
      website: "https://example.com",
      basePrice: new BN(1_000_000_000),
      requests: [
        {
          price: new BN(5_000_000_000),
          description: "Sponsored post on X"
        }
      ]
    };
 
    // 4. Create pair and initialize mint in one transaction
    await program.methods
      .createPair(params)
      .accounts({
        factory: factoryAccount.publicKey,
        pair: pairAddress,
        attentionTokenMint: mintKeypair.publicKey,
        creatorTokenAccount: creatorATA,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        vault: vaultAddress
      })
      .preInstructions([createMintAccountIx])
      .signers([mintKeypair])
      .rpc();

    // 5. Now that mint is initialized, create the ATA
    const createCreatorAtaIx = createAssociatedTokenAccountInstruction(
      creator.publicKey,
      creatorATA,
      creator.publicKey,
      mintKeypair.publicKey
    );

    // Create ATA in separate transaction
    await program.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(createCreatorAtaIx),
      []
    );

    // Verify
    const pair = await program.account.pair.fetch(pairAddress);
    expect(pair.creator.toString()).to.equal(creator.publicKey.toString());
    expect(pair.attentionTokenMint.toString()).to.equal(mintKeypair.publicKey.toString());
    expect(pair.basePrice.toString()).to.equal(params.basePrice.toString());

    const factory = await program.account.factory.fetch(factoryAccount.publicKey);
    expect(factory.pairsCount.toNumber()).to.equal(1);
});

it("Can swap SOL for attention tokens", async () => {
  // Create user's token account
  userATA = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      user.publicKey
  );

  // Create ATA instruction
  const createAtaIx = createAssociatedTokenAccountInstruction(
      user.publicKey,   // payer
      userATA,         // ata
      user.publicKey,  // owner
      mintKeypair.publicKey  // mint
  );

  const swapAmount = new BN(1_000_000_000); // 1 SOL
  const minAmountOut = new BN(1);

  // Get pair data to find creator
  const pairData = await program.account.pair.fetch(pairAddress);

  await program.methods
      .swap(swapAmount, minAmountOut, true)
      .accounts({
          pair: pairAddress,
          attentionTokenMint: mintKeypair.publicKey,
          userTokenAccount: userATA,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          creator: pairData.creator,  // Use creator from pair data
          factory: factoryAccount.publicKey,
          vault: vaultAddress,  // Add vault if contract requires it
      })
      .preInstructions([createAtaIx])
      .signers([user])
      .rpc();

  const ataInfo = await program.provider.connection.getTokenAccountBalance(userATA);
  expect(Number(ataInfo.value.amount)).to.be.greaterThan(0);
});
});