import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Flake } from "../target/types/flake";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createInitializeMintInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

describe("factory", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Flake as Program<Flake>;
  
  const creator = (program.provider as anchor.AnchorProvider).wallet;
  const user = anchor.web3.Keypair.generate();
  const feeRecipient = anchor.web3.Keypair.generate();
  let factoryAccount: anchor.web3.Keypair;
  let pairAddress: anchor.web3.PublicKey;
  let mintKeypair: anchor.web3.Keypair;
  let userATA: anchor.web3.PublicKey;

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
      .initializeFactory(new anchor.BN(100))
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
    expect(factory.feeRecipient.toString()).to.equal(feeRecipient.publicKey.toString());
    expect(factory.protocolFee.toNumber()).to.equal(100);
    expect(factory.pairsCount.toNumber()).to.equal(0);
  });

  it("Creates a pair with attention token", async () => {
    mintKeypair = anchor.web3.Keypair.generate();
    
    const [_pairAddress] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("pair"),
        creator.publicKey.toBuffer(),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])
      ],
      program.programId
    );
    pairAddress = _pairAddress;

    const creatorATA = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      creator.publicKey
    );

    const mintRent = await program.provider.connection.getMinimumBalanceForRentExemption(82);
    const createMintAccountIx = anchor.web3.SystemProgram.createAccount({
      fromPubkey: creator.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: 82,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    });

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
      requests: [
        {
          price: new anchor.BN(5000000000), // 5 SOL
          description: "Sponsored post on X"
        }
      ]
    };

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
    expect(pair.requests[0].price.toString()).to.equal(params.requests[0].price.toString());
    expect(pair.requests[0].description).to.equal(params.requests[0].description);
  });

  it("Can swap SOL for attention tokens", async () => {
    // Create user's token account
    userATA = await getAssociatedTokenAddress(
        mintKeypair.publicKey,
        user.publicKey
    );

    // Create ATA instruction
    const createAtaIx = createAssociatedTokenAccountInstruction(
        user.publicKey,  // payer
        userATA,         // ata address
        user.publicKey,  // owner
        mintKeypair.publicKey  // mint
    );

    const swapAmount = new anchor.BN(2000000000); // 2 SOL
    const minAmountOut = new anchor.BN(1); // Minimum amount to receive

    await program.methods
        .swap(swapAmount, minAmountOut, true)
        .accounts({
            pair: pairAddress,
            attentionTokenMint: mintKeypair.publicKey,
            userTokenAccount: userATA,
            user: user.publicKey,
            creator: creator.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .preInstructions([createAtaIx])
        .signers([user])
        .rpc();

    // Verify token balance
    const ataInfo = await program.provider.connection.getTokenAccountBalance(userATA);
    expect(Number(ataInfo.value.amount)).to.be.greaterThan(minAmountOut.toNumber());
});

  it("Fails to initialize factory with invalid fee", async () => {
    const invalidFactoryAccount = anchor.web3.Keypair.generate();
    
    try {
      await program.methods
        .initializeFactory(new anchor.BN(10001))
        .accounts({
          factory: invalidFactoryAccount.publicKey,
          feeRecipient: feeRecipient.publicKey,
          authority: creator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([invalidFactoryAccount])
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
        Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])
      ],
      program.programId
    );

    const creatorATA = await getAssociatedTokenAddress(
      invalidMintKeypair.publicKey,
      creator.publicKey
    );

    const mintRent = await program.provider.connection.getMinimumBalanceForRentExemption(82);
    const createMintAccountIx = anchor.web3.SystemProgram.createAccount({
      fromPubkey: creator.publicKey,
      newAccountPubkey: invalidMintKeypair.publicKey,
      space: 82,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    });

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
      basePrice: new anchor.BN(0),
      requests: []
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