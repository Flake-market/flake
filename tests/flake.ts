import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Flake } from "../target/types/flake";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createInitializeMintInstruction } from "@solana/spl-token";

describe("factory", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Flake as Program<Flake>;
  
  // Use provider wallet instead of generating new keypair
  const creator = (program.provider as anchor.AnchorProvider).wallet;
  const feeRecipient = anchor.web3.Keypair.generate();
  let factoryAccount: anchor.web3.Keypair;
  let pairAddress: anchor.web3.PublicKey;
  let mintKeypair: anchor.web3.Keypair;

  it("Initializes factory", async () => {
    factoryAccount = anchor.web3.Keypair.generate();
    
    await program.methods
      .initializeFactory(new anchor.BN(100)) // 1% protocol fee
      .accounts({
        factory: factoryAccount.publicKey,
        feeRecipient: feeRecipient.publicKey,
        authority: creator.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([factoryAccount])  // Only include factoryAccount as signer
      .rpc();

    const factory = await program.account.factory.fetch(factoryAccount.publicKey);
    expect(factory.authority.toString()).to.equal(creator.publicKey.toString());
    expect(factory.feeRecipient.toString()).to.equal(feeRecipient.publicKey.toString());
    expect(factory.protocolFee.toNumber()).to.equal(100);
    expect(factory.pairsCount.toNumber()).to.equal(0);
  });

 it("Creates a pair with attention token", async () => {
    // Create mint keypair
    mintKeypair = anchor.web3.Keypair.generate();
    
    // Calculate PDA for pair
    const [_pairAddress] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("pair"),
        creator.publicKey.toBuffer(),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])
      ],
      program.programId
    );
    pairAddress = _pairAddress;

    // Get creator's ATA
    const creatorATA = await anchor.utils.token.associatedAddress({
      mint: mintKeypair.publicKey,
      owner: creator.publicKey
    });

    // Create mint account first
    const mintRent = await program.provider.connection.getMinimumBalanceForRentExemption(82);
    const createMintAccountIx = anchor.web3.SystemProgram.createAccount({
      fromPubkey: creator.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: 82,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    });

    // Initialize mint instruction
    const initMintIx = createInitializeMintInstruction(
      mintKeypair.publicKey,
      9,
      pairAddress,
      pairAddress,
    );

    const params = {
      name: "Creator Token",
      ticker: "CTKN",
      description: "Test token description",
      tokenImage: "https://example.com/image.png",
      twitter: "@creator",
      telegram: "@creator",
      website: "https://example.com",
      quoteToken: anchor.web3.SystemProgram.programId,
      basePrice: new anchor.BN(1000000000),
    };

    // Create pair transaction
    const createPairTx = await program.methods
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
      })
      .preInstructions([createMintAccountIx, initMintIx])
      .signers([mintKeypair])
      .rpc();

    const pair = await program.account.pair.fetch(pairAddress);
    expect(pair.creator.toString()).to.equal(creator.publicKey.toString());
    expect(pair.attentionTokenMint.toString()).to.equal(mintKeypair.publicKey.toString());
    expect(pair.name).to.equal(params.name);
    expect(pair.ticker).to.equal(params.ticker);
    expect(pair.basePrice.toString()).to.equal(params.basePrice.toString());
  });

  it("Fails to initialize factory with invalid fee", async () => {
    const invalidFactoryAccount = anchor.web3.Keypair.generate();
    
    try {
      await program.methods
        .initializeFactory(new anchor.BN(10001)) // > 100%
        .accounts({
          factory: invalidFactoryAccount.publicKey,
          feeRecipient: feeRecipient.publicKey,
          authority: creator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([invalidFactoryAccount]) // Only include factory account
        .rpc();
      expect.fail("Expected the initialization to fail");
    } catch (error) {
      expect(error.message).to.include("Protocol fee must be between 0 and 10000");
    }
  });

  it("Fails to create pair with invalid base price", async () => {
    const invalidMintKeypair = anchor.web3.Keypair.generate();
    
    const [invalidPairAddress] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("pair"),
        creator.publicKey.toBuffer(),
        Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]) // pairs_count = 1
      ],
      program.programId
    );

    const creatorATA = await anchor.utils.token.associatedAddress({
      mint: invalidMintKeypair.publicKey,
      owner: creator.publicKey
    });
    // Create mint account first
    const mintRent = await program.provider.connection.getMinimumBalanceForRentExemption(82);
    const createMintAccountIx = anchor.web3.SystemProgram.createAccount({
      fromPubkey: creator.publicKey,
      newAccountPubkey: invalidMintKeypair.publicKey,
      space: 82,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    });

    // Initialize mint instruction
    const initMintIx = createInitializeMintInstruction(
      invalidMintKeypair.publicKey,
      9,
      invalidPairAddress,
      invalidPairAddress,
    );
    const invalidParams = {
      name: "Creator Token",
      ticker: "CTKN",
      description: "Test token description",
      tokenImage: "https://example.com/image.png",
      twitter: "@creator",
      telegram: "@creator",
      website: "https://example.com",
      quoteToken: anchor.web3.SystemProgram.programId,
      basePrice: new anchor.BN(0), // Invalid base price
    };
 
    try {
      await program.methods
        .createPair(invalidParams)
        .accounts({
          factory: factoryAccount.publicKey,
          pair: invalidPairAddress,
          attentionTokenMint: invalidMintKeypair.publicKey,
          creatorTokenAccount: creatorATA,
          creator: creator.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([createMintAccountIx, initMintIx])
        .signers([invalidMintKeypair])
        .rpc();
      expect.fail("Expected the pair creation to fail");
    } catch (error) {
      expect(error.message).to.include("Base price must be greater than 0");
    }
  });
});