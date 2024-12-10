import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID, 
    getAssociatedTokenAddress, 
    createInitializeMintInstruction, 
    createAssociatedTokenAccountInstruction 
} from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { Flake } from '../target/types/flake';

// Initialize constants
const PROGRAM_ID = new PublicKey("8zYMYyqVyLtY8HZQjcCcvfAHzstZRRbkRyvLc9fmvYHG");
const RPC_URL = "https://api.devnet.solana.com";

// Utility function to sleep
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    try {
        // Load wallet
        console.log("Loading wallet...");
        const keyPath = path.join(__dirname, '..', 'id.json');
        if (!fs.existsSync(keyPath)) {
            throw new Error('Wallet key file not found. Please place your id.json in the same directory as this script.');
        }

        const rawKey = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
        const keypair = Keypair.fromSecretKey(new Uint8Array(rawKey));
        const wallet = new Wallet(keypair);
        
        // Setup connection and provider
        const connection = new Connection(RPC_URL, {
            commitment: "confirmed",
            confirmTransactionInitialTimeout: 60000
        });
        
        // Create the provider
        const provider = new AnchorProvider(
            connection,
            wallet,
            { commitment: "confirmed" }
        );
        
        // Set this as the default provider
        anchor.setProvider(provider);
        
        // Generate the program
        const idlPath = path.join(__dirname, '..', 'target', 'idl', 'flake.json');
        const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
        const program = new Program<Flake>(idl as Flake, provider);
        console.log("Program Id", program.programId);

        console.log("Starting tests on devnet...");
        console.log("Wallet:", wallet.publicKey.toString());

        // Check and request airdrop if needed
        let balance = await connection.getBalance(wallet.publicKey);
        console.log("Initial balance:", balance / LAMPORTS_PER_SOL, "SOL");

        if (balance < LAMPORTS_PER_SOL) {
            console.log("Requesting airdrop...");
            const airdropSig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(airdropSig);
            console.log("Airdrop confirmed. New balance:", (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL, "SOL");
            await sleep(2000);
        }

        // Test 1: Create Factory
        console.log("\nTest 1: Creating factory...");
        const factoryAccount = Keypair.generate();
        const feeRecipient = wallet.publicKey; // Using wallet as fee recipient for testing

        await program.methods
            .initializeFactory(new BN(100))
            .accounts({
                factory: factoryAccount.publicKey,
                feeRecipient: feeRecipient,
                authority: wallet.publicKey,
            })
            .signers([factoryAccount])
            .rpc();
            
        console.log("Factory created:", factoryAccount.publicKey.toString());
        await sleep(2000);

        // Test 2: Create Pair with Attention Token
        console.log("\nTest 2: Creating pair with attention token...");
        const mintKeypair = Keypair.generate();
        
   // After factory creation
const factory = await program.account.factory.fetch(factoryAccount.publicKey);
console.log("\nFactory pairs count:", factory.pairsCount.toString());

// Use factory's pairs_count for PDA
const [pairAddress, bump] = PublicKey.findProgramAddressSync(
    [
        Buffer.from("pair"),
        wallet.publicKey.toBuffer(),
        factory.pairsCount.toArrayLike(Buffer, 'le', 8)
    ],
    program.programId
);

console.log("Generated PDA:", pairAddress.toString());
const accountInfo = await connection.getAccountInfo(pairAddress);
if (accountInfo) {
    console.error("Error: PDA already in use despite factory count");
    process.exit(1);
}

        const creatorATA = await getAssociatedTokenAddress(
            mintKeypair.publicKey,
            wallet.publicKey
        );

        const mintRent = await connection.getMinimumBalanceForRentExemption(82);
        const createMintAccountIx = SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: mintKeypair.publicKey,
            space: 82,
            lamports: mintRent,
            programId: TOKEN_PROGRAM_ID,
        });

        const initMintIx = createInitializeMintInstruction(
            mintKeypair.publicKey,
            9,
            pairAddress,
            pairAddress
        );

        const params = {
            name: "Creator Token",
            ticker: "CTKN",
            description: "Test token description",
            tokenImage: "https://example.com/image.png",
            twitter: "@creator",
            telegram: "@creator",
            website: "https://example.com",
            quoteToken: SystemProgram.programId,
            basePrice: new BN(1000000000), // 1 SOL
            requests: [
                {
                    price: new BN(5000000000), // 5 SOL
                    description: "Sponsored post on X"
                }
            ]
        };

        await program.methods
            .createPair(params)
            .accounts({
                factory: factoryAccount.publicKey,
                attentionTokenMint: mintKeypair.publicKey,
                creatorTokenAccount: creatorATA,
                creator: wallet.publicKey,
            })
            .preInstructions([createMintAccountIx, initMintIx])
            .signers([mintKeypair])
            .rpc();

        console.log("Pair created:", pairAddress.toString());
        console.log("Attention token mint:", mintKeypair.publicKey.toString());
        await sleep(2000);

        // Test 3: Swap SOL for attention tokens
        console.log("\nTest 3: Testing swap...");
        
        // Create a test user
        const testUser = Keypair.generate();
        const airdropSig = await connection.requestAirdrop(testUser.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(airdropSig);
        console.log("Test user funded:", testUser.publicKey.toString());
        await sleep(2000);

        // Create user's token account
        const userATA = await getAssociatedTokenAddress(
            mintKeypair.publicKey,
            testUser.publicKey
        );

        // Create ATA instruction
        const createAtaIx = createAssociatedTokenAccountInstruction(
            testUser.publicKey,
            userATA,
            testUser.publicKey,
            mintKeypair.publicKey
        );

        const swapAmount = new BN(2000000000); // 2 SOL
        const minAmountOut = new BN(1); // Minimum amount to receive

        await program.methods
            .swap(swapAmount, minAmountOut, true)
            .accounts({
                pair: pairAddress,
                attentionTokenMint: mintKeypair.publicKey,
                userTokenAccount: userATA,
                user: testUser.publicKey,
                creator: wallet.publicKey,
            })
            .preInstructions([createAtaIx])
            .signers([testUser])
            .rpc();

        // Get token balance
        const ataInfo = await connection.getTokenAccountBalance(userATA);
        console.log("User token balance:", ataInfo.value.amount);

        console.log("\nAll tests completed successfully!");

    } catch (error) {
        console.error("\nError occurred:");
        console.error(error);
        if (error.logs) {
            console.error("\nProgram Logs:");
            error.logs.forEach((log: string, i: number) => console.error(`${i + 1}: ${log}`));
        }
    }
}

main();