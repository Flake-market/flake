use anchor_lang::prelude::*;
use anchor_spl::token::{Token, Mint, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("HAnx7CUgV4WcCUjLe4616Zm3fgobLEBnH6XUVtr8JNSk");

#[program]
pub mod flake {
    use super::*;

    pub fn initialize_factory(
        ctx: Context<InitializeFactory>,
        protocol_fee: u64,
    ) -> Result<()> {
        require!(protocol_fee <= 10000, FactoryError::InvalidProtocolFee);
        
        let factory = &mut ctx.accounts.factory;
        factory.authority = ctx.accounts.authority.key();
        factory.fee_recipient = ctx.accounts.fee_recipient.key();
        factory.protocol_fee = protocol_fee;
        factory.pairs_count = 0;

        Ok(())
    }

    pub fn create_pair(
        ctx: Context<CreatePair>,
        params: CreatePairParams,
    ) -> Result<()> {
        require!(params.base_price > 0, FactoryError::InvalidBasePrice);
        require!(
            params.name.len() <= 32 && 
            params.ticker.len() <= 10 && 
            params.description.len() <= 200,
            FactoryError::InvalidStringLength
        );

        let pair = &mut ctx.accounts.pair;
        let factory = &mut ctx.accounts.factory;

        pair.bump = ctx.bumps.pair;
        pair.creator = ctx.accounts.creator.key();
        pair.attention_token_mint = ctx.accounts.attention_token_mint.key();
        pair.creator_token_account = ctx.accounts.creator_token_account.key();
        pair.quote_token = params.quote_token;
        pair.base_price = params.base_price;
        pair.protocol_fee = factory.protocol_fee;
        
        pair.name = params.name;
        pair.ticker = params.ticker;
        pair.description = params.description;
        pair.token_image = params.token_image;
        pair.twitter = params.twitter;
        pair.telegram = params.telegram;
        pair.website = params.website;

        factory.pairs_count = factory.pairs_count.checked_add(1).unwrap();

        Ok(())
    }

    pub fn initialize_token(ctx: Context<InitializeToken>) -> Result<()> {
        let cpi_context = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::InitializeMint {
                mint: ctx.accounts.mint.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
        );
        
        anchor_spl::token::initialize_mint(
            cpi_context,
            9,  // decimals
            &ctx.accounts.pair.key(),  // mint authority
            Some(&ctx.accounts.pair.key()), // freeze authority
        )?;
    
        Ok(())
    }
}

#[account]
#[derive(Default)]
pub struct Factory {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub protocol_fee: u64,
    pub pairs_count: u64,
}

// Add this struct to the account validation structures
#[derive(Accounts)]
pub struct InitializeToken<'info> {
    #[account(mut)]
    pub pair: Account<'info, Pair>,
    /// CHECK: Initialized in CPI
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[account]
#[derive(Default)]
pub struct Pair {
    pub bump: u8,
    pub creator: Pubkey,
    pub attention_token_mint: Pubkey,
    pub creator_token_account: Pubkey,
    pub quote_token: Pubkey,
    pub base_price: u64,
    pub protocol_fee: u64,
    
    pub name: String,
    pub ticker: String,
    pub description: String,
    pub token_image: String,
    pub twitter: String,
    pub telegram: String,
    pub website: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct CreatePairParams {
    pub name: String,
    pub ticker: String,
    pub description: String,
    pub token_image: String,
    pub twitter: String,
    pub telegram: String,
    pub website: String,
    pub quote_token: Pubkey,
    pub base_price: u64,
}

#[derive(Accounts)]
pub struct InitializeFactory<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 8 + 8
    )]
    pub factory: Account<'info, Factory>,
    
    /// CHECK: Only storing pubkey
    pub fee_recipient: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: CreatePairParams)]
pub struct CreatePair<'info> {
    #[account(mut)]
    pub factory: Account<'info, Factory>,
    
    #[account(
        init,
        payer = creator,
        seeds = [b"pair", creator.key().as_ref(), factory.pairs_count.to_le_bytes().as_ref()],
        bump,
        space = 8 + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 
                (4 + 32) + (4 + 10) + (4 + 200) + 
                (4 + 100) + (4 + 50) + (4 + 50) + (4 + 100)
    )]
    pub pair: Account<'info, Pair>,
    
    /// CHECK: Created by token program
    #[account(mut)]
    pub attention_token_mint: UncheckedAccount<'info>,
    
    /// CHECK: Created by token program
    #[account(mut)]
    pub creator_token_account: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub creator: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[error_code]
pub enum FactoryError {
    #[msg("Protocol fee must be between 0 and 10000 (100%)")]
    InvalidProtocolFee,
    #[msg("Base price must be greater than 0")]
    InvalidBasePrice,
    #[msg("String length exceeds maximum allowed")]
    InvalidStringLength,
}