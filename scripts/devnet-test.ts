import {
    Connection,
    PublicKey,
    Keypair,
    SystemProgram,
    LAMPORTS_PER_SOL
  } from '@solana/web3.js';
  import * as anchor from '@coral-xyz/anchor';
  import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
  import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress
  } from '@solana/spl-token';
  import fs from 'fs';
  import path from 'path';
  import { Flake } from '../target/types/flake';
  
  const PROGRAM_ID = new PublicKey("5cYJsEQDUHGQuZ3SuSRjAN14g23iXtWboqoFJ6fJHtYM");
  const RPC_URL = "https://api.devnet.solana.com";//"http://127.0.0.1:8899"; // local validator URL
  
  // REPLACE 
  let FACTORY_PUBKEY= null; //new PublicKey("Gj2KCKfJFwe4UWuAXDytkumRVnVXmyfzLy7Z1gwery2p");
  
  async function loadWallet(): Promise<Wallet> {
    const keyPath = path.join(__dirname, '..' ,'id2.json');
    if (!fs.existsSync(keyPath)) {
      throw new Error('Wallet key file not found. Please place id.json in the script directory.');
    }
    const rawKey = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    const keypair = Keypair.fromSecretKey(new Uint8Array(rawKey));
    return new Wallet(keypair);
  }
  
  async function getProgram(wallet: Wallet): Promise<Program<Flake>> {
    const connection = new Connection(RPC_URL, { commitment: "confirmed" });
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);
  
    const idlPath = path.join(__dirname, '..', 'target', 'idl', 'flake.json');
    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
    return new Program<Flake>(idl as Flake, provider);
  }

  async function createFactory(program: Program<Flake>, feeRecipient: PublicKey): Promise<PublicKey> {
    const factory = Keypair.generate();
    
    console.log("Creating factory...");
    await program.methods
      .initializeFactory(new BN(0))
      .accounts({
        factory: factory.publicKey,
        feeRecipient: feeRecipient,
        authority: program.provider.publicKey,
      })
      .signers([factory])
      .rpc();
      
    console.log("Factory created:", factory.publicKey.toString());
    process.exit(1);

    return factory.publicKey;
  }
  
  async function createPair(program: Program<Flake>, factoryPubkey: PublicKey, params: {
    name: string;
    ticker: string;
    description: string;
    tokenImage: string;
    twitter: string;
    telegram: string;
    website: string;
    basePrice: number;
    requests: { price: number; description: string }[];
  }) {
    // Fetch the current pairs_count from the factory
    const factory = await program.account.factory.fetch(factoryPubkey);
    const pairsCount = factory.pairsCount;
  
    // Derive the pair address
    const [pairAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pair"),
        program.provider.publicKey.toBuffer(),
        new BN(pairsCount).toArrayLike(Buffer, "le", 8)
      ],
      program.programId
    );
  
    // Derive the vault address
    const [vaultAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        pairAddress.toBuffer()
      ],
      program.programId
    );
  
    // Create a new mint account for the attention token
    const mintKeypair = Keypair.generate();
    const creatorTokenAccountAddress = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      program.provider.publicKey
    );
  
    const formattedParams = {
      name: params.name,
      ticker: params.ticker,
      description: params.description,
      tokenImage: params.tokenImage,
      twitter: params.twitter,
      telegram: params.telegram,
      website: params.website,
      basePrice: new BN(params.basePrice),
      requests: params.requests.map(r => ({
        price: new BN(r.price),
        description: r.description,
      })),
    };
  
    const mintRent = await program.provider.connection.getMinimumBalanceForRentExemption(82);
    const createMintAccountIx = SystemProgram.createAccount({
      fromPubkey: program.provider.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: 82,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    });
  
    console.log("\nCreating new pair with params:", pairsCount, pairAddress.toString());

    try {
      await program.methods
        .createPair(formattedParams)
        .accounts({
          factory: factoryPubkey,
         // pair: pairAddress,
          attentionTokenMint: mintKeypair.publicKey,
          creatorTokenAccount: creatorTokenAccountAddress,
          creator: program.provider.publicKey,
        //  tokenProgram: TOKEN_PROGRAM_ID,
        //  associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        // systemProgram: SystemProgram.programId,
        //  rent: anchor.web3.SYSVAR_RENT_PUBKEY,
       //   vault: vaultAddress,
        })
        .preInstructions([createMintAccountIx])
        .signers([mintKeypair])
        .rpc();
  
      console.log("Pair created at:", pairAddress.toString());
      console.log("Attention token mint:", mintKeypair.publicKey.toString());
      console.log("Vault address:", vaultAddress.toString());
  
      return { pairAddress, mint: mintKeypair.publicKey, creatorTokenAccountAddress, vaultAddress };
    } catch (error) {
      console.error("Error creating pair:", error);
      throw error;
    }
  }
  
  async function fetchPairDetails(program: Program<Flake>, pairAddress: PublicKey) {
    const pair = await program.account.pair.fetch(pairAddress);
    console.log("\n--- Pair Details ---");
    console.log("Name:", pair.name);
    console.log("Ticker:", pair.ticker);
    console.log("Description:", pair.description);
    console.log("Base Price:", pair.basePrice.toString());
    console.log("Requests:", pair.requests.map((r: any) => ({
      price: r.price.toString(),
      description: r.description
    })));
    const factory = await program.account.factory.fetch(FACTORY_PUBKEY);
    const pairCount = factory.pairsCount;
  
    console.log("Pair count", pairCount.toString());
    console.log("--------------------\n");
  }
  
  async function main() {
    const wallet = await loadWallet();
    const program = await getProgram(wallet);
    const connection = program.provider.connection;
  
    // Airdrop if needed
    const balance = await connection.getBalance(wallet.publicKey);
    if (balance < LAMPORTS_PER_SOL) {
      console.log("Airdropping SOL for local testing...");
      const airdropSig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
    }
  
  
    // Create a new pair using the existing factory
    const params = {
      name: "New Token",
      ticker: "NEW",
      description: "Another token created from existing factory",
      tokenImage: "https://example.com/newtoken.png",
      twitter: "@newtoken",
      telegram: "@newtokentelegram",
      website: "https://newtoken.com",
      basePrice: 2_000_000_000, // 2 SOL
      requests: [
        { price: 5_000_000_000, description: "Special promo tweet" }
      ],
    };

    if(!FACTORY_PUBKEY) {
        console.log("No factory found, creating new factory...");
        FACTORY_PUBKEY = await createFactory(program, program.provider.publicKey);
    } else {
        console.log("Factory found, reusing it to create the pair...");
    }
    const { pairAddress, mint } = await createPair(program, FACTORY_PUBKEY, params);
  
    // Fetch and print details of the newly created pair
    await fetchPairDetails(program, pairAddress);
  }
  
  main().catch(err => {
    console.error(err);
  });
  