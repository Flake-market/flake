import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Flake } from "../target/types/flake";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
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

    const factory = await program.account.factory.fetch(
      factoryAccount.publicKey
    );
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
        pairsCount.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [vaultAddress] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), pairAddress.toBuffer()],
      program.programId
    );

    // 2. Get ATA address (but don't create yet)
    creatorATA = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      creator.publicKey
    );

    // 3. Create mint account (only space allocation)
    const mintRent =
      await program.provider.connection.getMinimumBalanceForRentExemption(82);
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
      basePrice: new BN(5_000_000),
      requests: [
        {
          price: new BN(100),
          description: "Sponsored post on X",
        },
      ],
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
        vault: vaultAddress,
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
    expect(pair.attentionTokenMint.toString()).to.equal(
      mintKeypair.publicKey.toString()
    );
    expect(pair.basePrice.toString()).to.equal(params.basePrice.toString());

    const factory = await program.account.factory.fetch(
      factoryAccount.publicKey
    );
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
      user.publicKey,
      userATA,
      user.publicKey,
      mintKeypair.publicKey
    );

    const swapAmount = new BN(2_000_000_000); // 5 SOL
    const minAmountOut = new BN(1);

    // Get pair data to find creator
    const pairData = await program.account.pair.fetch(pairAddress);
    // console.log("Base price:", pairData.basePrice.toString());
    // console.log("SOL amount to swap:", swapAmount.toString());
    // console.log(
    //   "Expected tokens:",
    //   swapAmount.div(pairData.basePrice).toString()
    // );

    await program.methods
      .swap(swapAmount, minAmountOut, true)
      .accounts({
        pair: pairAddress,
        attentionTokenMint: mintKeypair.publicKey,
        userTokenAccount: userATA,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        creator: pairData.creator,
        factory: factoryAccount.publicKey,
        vault: vaultAddress,
      })
      .preInstructions([createAtaIx])
      .signers([user])
      .rpc();

    let tokenInfo = await program.provider.connection.getTokenAccountBalance(
      userATA
    );
    //console.log("Actual tokens received:", tokenInfo.value.amount);
  });

  it("Can submit a request for advertisement", async () => {
    // Get initial token balances
    let tokenInfo = await program.provider.connection.getTokenAccountBalance(
      userATA
    );
    const initialUserBalance = Number(tokenInfo.value.amount);
    console.log("Initial user token balance:", initialUserBalance);

    let creatorTokenInfo =
      await program.provider.connection.getTokenAccountBalance(creatorATA);
    const initialCreatorBalance = Number(creatorTokenInfo.value.amount);
    //  console.log("Initial creator token balance:", initialCreatorBalance);

    const pairData = await program.account.pair.fetch(pairAddress);
    const requestIndex = 0;
    const requiredTokens = pairData.requests[requestIndex].price;
    //  console.log("Required tokens for request:", requiredTokens.toString());

    const adText = "This is a sponsored post about an awesome product!";

    await program.methods
      .submitRequest(requestIndex, adText)
      .accounts({
        pair: pairAddress,
        attentionTokenMint: mintKeypair.publicKey,
        userTokenAccount: userATA,
        creatorTokenAccount: creatorATA, // Added creator's token account
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    tokenInfo = await program.provider.connection.getTokenAccountBalance(
      userATA
    );
    const finalUserBalance = Number(tokenInfo.value.amount);
    console.log("Final user token balance:", finalUserBalance);
    console.log("User tokens spent:", initialUserBalance - finalUserBalance);

    creatorTokenInfo = await program.provider.connection.getTokenAccountBalance(
      creatorATA
    );
    const finalCreatorBalance = Number(creatorTokenInfo.value.amount);

    // Verify token transfer
    expect(finalUserBalance).to.equal(initialUserBalance - requiredTokens);
    expect(finalCreatorBalance).to.equal(
      parseInt(initialCreatorBalance) + parseInt(requiredTokens)
    );

    // Verify request was stored
    const updatedPair = await program.account.pair.fetch(pairAddress);
    const latestRequest =
      updatedPair.pendingRequests[updatedPair.pendingRequests.length - 1];
    expect(latestRequest.user.toString()).to.equal(user.publicKey.toString());
    expect(latestRequest.requestIndex).to.equal(requestIndex);
    expect(latestRequest.adText).to.equal(adText);
  });

  it("Cannot submit request with invalid index", async () => {
    const invalidIndex = 99;
    const adText = "This should fail";

    try {
      await program.methods
        .submitRequest(invalidIndex, adText)
        .accounts({
          pair: pairAddress,
          attentionTokenMint: mintKeypair.publicKey,
          creatorTokenAccount: creatorATA,
          userTokenAccount: userATA,
          user: user.publicKey,
        })
        .signers([user])
        .rpc();

      // If we reach here, the test should fail
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error.message).to.include("Invalid request index");
    }
  });
  it("Cannot submit request with too long ad text", async () => {
    const requestIndex = 0;
    // Create string longer than 280 characters
    const adText = "x".repeat(281);

    try {
      await program.methods
        .submitRequest(requestIndex, adText)
        .accounts({
          pair: pairAddress,
          attentionTokenMint: mintKeypair.publicKey,
          creatorTokenAccount: creatorATA,
          userTokenAccount: userATA,
          user: user.publicKey,
        })
        .signers([user])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error.message).to.include("Ad text too long");
    }
  });
  it("Creator can accept request", async () => {
    // First submit a request
    const requestIndex = 0;
    const adText = "This is a sponsored post about an awesome product!";

    await program.methods
      .submitRequest(requestIndex, adText)
      .accounts({
        pair: pairAddress,
        attentionTokenMint: mintKeypair.publicKey,
        userTokenAccount: userATA,
        creatorTokenAccount: creatorATA,
        user: user.publicKey,
      })
      .signers([user])
      .rpc();

    // Now accept the request
    await program.methods
      .acceptRequest(requestIndex)
      .accounts({
        pair: pairAddress,
        creator: creator.publicKey,
      })
      .rpc();

    // Verify the request was accepted
    const pair = await program.account.pair.fetch(pairAddress);
    const request = pair.pendingRequests[0];

    expect(request.status).to.deep.equal({ accepted: {} });
    expect(request.requestIndex).to.equal(requestIndex);
    expect(request.user.toString()).to.equal(user.publicKey.toString());
  });
  it("Non-creator cannot accept request", async () => {
    const requestIndex = 0;

    try {
      await program.methods
        .acceptRequest(requestIndex)
        .accounts({
          pair: pairAddress,
          creator: user.publicKey, // Using user instead of creator
        })
        .signers([user])
        .rpc();

      expect.fail("Should have thrown unauthorized creator error");
    } catch (error) {
      expect(error.message).to.include("Unauthorized caller");
    }
  });

  it("Cannot accept non-existent request", async () => {
    const invalidRequestIndex = 99;

    try {
      await program.methods
        .acceptRequest(invalidRequestIndex)
        .accounts({
          pair: pairAddress,
          creator: creator.publicKey,
        })
        .rpc();

      expect.fail("Should have thrown request not found error");
    } catch (error) {
      expect(error.message).to.include("RequestNotFound");
    }
  });

  // it("Cannot accept already processed request", async () => {
  //   const requestIndex = 0;
  //   const adText = "Another sponsored post!";

  //   // Submit new request
  //   await program.methods
  //       .submitRequest(requestIndex, adText)
  //       .accounts({
  //           pair: pairAddress,
  //           attentionTokenMint: mintKeypair.publicKey,
  //           userTokenAccount: userATA,
  //           creatorTokenAccount: creatorATA,
  //           user: user.publicKey,
  //       })
  //       .signers([user])
  //       .rpc();

  //   // Accept it first time
  //   await program.methods
  //       .acceptRequest(requestIndex)
  //       .accounts({
  //           pair: pairAddress,
  //           creator: creator.publicKey,
  //       })
  //       .rpc();

  //   // Try to accept it again
  //   // try {
  //       await program.methods
  //           .acceptRequest(requestIndex)
  //           .accounts({
  //               pair: pairAddress,
  //               creator: creator.publicKey,
  //           })
  //           .rpc();

  //       //expect.fail("Should have thrown error for already processed request");
  //   // } catch (error) {
  //   //     console.error(error);
  //   //     expect(error.message).to.include("Request not found or not in pending status");
  //   // }
  // });
});
