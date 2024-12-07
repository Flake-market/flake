use anchor_lang::prelude::*;

declare_id!("HAnx7CUgV4WcCUjLe4616Zm3fgobLEBnH6XUVtr8JNSk");

#[program]
pub mod flake {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        factory.owner = ctx.accounts.owner.key();
        factory.pair_count = 0;
        Ok(())
    }

    pub fn create_pair(
        ctx: Context<CreatePair>,
        token_a: Pubkey,
        token_b: Pubkey,
        bump: u8,
    ) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        let pair = &mut ctx.accounts.pair;
        
        // Initialize pair data
        pair.token_a = token_a;
        pair.token_b = token_b;
        pair.authority = factory.key();
        pair.bump = bump;
        // Initialize reserves
        pair.reserve_a = 0;
        pair.reserve_b = 0;

        factory.pair_count += 1;

        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        let pair = &mut ctx.accounts.pair;
        
        // Dummy swap calculation (this would normally use proper bonding curve logic)
        // For poc purposes, I used a simple 1:1 ratio
        require!(amount_in > 0, CustomError::InvalidAmount);
        require!(pair.reserve_a > 0 && pair.reserve_b > 0, CustomError::InsufficientLiquidity);
        
        // Check if swapping token_a for token_b or vice versa
        if ctx.accounts.token_in.key() == pair.token_a {
            let amount_out = amount_in;  
            require!(amount_out >= min_amount_out, CustomError::SlippageExceeded);
            require!(amount_out <= pair.reserve_b, CustomError::InsufficientLiquidity);
            
            pair.reserve_a = pair.reserve_a.checked_add(amount_in).unwrap();
            pair.reserve_b = pair.reserve_b.checked_sub(amount_out).unwrap();
        } else {
            let amount_out = amount_in;  
            require!(amount_out >= min_amount_out, CustomError::SlippageExceeded);
            require!(amount_out <= pair.reserve_a, CustomError::InsufficientLiquidity);
            
            pair.reserve_b = pair.reserve_b.checked_add(amount_in).unwrap();
            pair.reserve_a = pair.reserve_a.checked_sub(amount_out).unwrap();
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 8 // discriminator + owner pubkey + pair count
    )]
    pub factory: Account<'info, Factory>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(token_a: Pubkey, token_b: Pubkey, bump: u8)]
pub struct CreatePair<'info> {
    #[account(mut)]
    pub factory: Account<'info, Factory>,
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 32 + 1 + 8 + 8, // discriminator + token_a + token_b + authority + bump + reserve_a + reserve_b
        seeds = [b"pair".as_ref(), token_a.as_ref(), token_b.as_ref()],
        bump
    )]
    pub pair: Account<'info, Pair>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub pair: Account<'info, Pair>,
    /// CHECK: Verified in the swap logic
    pub token_in: AccountInfo<'info>,
    /// CHECK: Verified in the swap logic
    pub token_out: AccountInfo<'info>,
    pub user: Signer<'info>,
}

#[account]
pub struct Factory {
    pub owner: Pubkey,
    pub pair_count: u64,
}

#[account]
pub struct Pair {
    pub token_a: Pubkey,
    pub token_b: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
    pub reserve_a: u64,
    pub reserve_b: u64,
}

#[error_code]
pub enum CustomError {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
}