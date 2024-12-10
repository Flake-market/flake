import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createInitializeMintInstruction, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { IDL, Flake } from '../target/types/flake';

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
        
        // Generate the program with the provider
        const program = new Program<Flake>(IDL, PROGRAM_ID, provider);

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
        const feeRecipient = Keypair.generate();

        const tx = await program.methods
            .initializeFactory(new BN(100))
            .accounts({
                factory: factoryAccount.publicKey,
                feeRecipient: feeRecipient.publicKey,
                authority: wallet.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([factoryAccount])
            .rpc({ skipPreflight: true });
            
        await provider.connection.confirmTransaction(tx, "confirmed");
        console.log("Factory created:", factoryAccount.publicKey.toString());
        console.log("Transaction:", tx);
        await sleep(2000);

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