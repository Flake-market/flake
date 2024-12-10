use anchor_lang::{prelude::*, solana_program, system_program};
use anchor_spl::token::{self, Token, MintTo, Burn};
use anchor_spl::associated_token::AssociatedToken;
use solana_program::system_instruction;
use solana_program::program::invoke;

declare_id!("8zYMYyqVyLtY8HZQjcCcvfAHzstZRRbkRyvLc9fmvYHG");

#[program]
pub mod flake {
    use anchor_lang::system_program;
    use solana_program::program::invoke_signed;

    use super::*;

    pub fn initialize_factory(ctx: Context<InitializeFactory>, protocol_fee: u64) -> Result<()> {
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

        for request in &params.requests {
            require!(request.price > 0, FactoryError::InvalidRequestPrice);
            require!(request.description.len() <= 200, FactoryError::InvalidStringLength);
        }

        let pair = &mut ctx.accounts.pair;
        let factory = &mut ctx.accounts.factory;

        // Set fields in pair
        pair.bump = ctx.bumps.pair;
        pair.creator = ctx.accounts.creator.key();
        pair.attention_token_mint = ctx.accounts.attention_token_mint.key();
        pair.creator_token_account = ctx.accounts.creator_token_account.key();
        pair.base_price = params.base_price;
        pair.protocol_fee = factory.protocol_fee;
        pair.creator_fee = 100; // 1% creator fee
        pair.creation_number = factory.pairs_count;
        
        pair.name = params.name;
        pair.ticker = params.ticker;
        pair.description = params.description;
        pair.token_image = params.token_image;
        pair.twitter = params.twitter;
        pair.telegram = params.telegram;
        pair.website = params.website;
        pair.requests = params.requests;

        pair.vault = ctx.accounts.vault.key();

        // Increase pairs_count
        factory.pairs_count = factory.pairs_count.checked_add(1).unwrap();


        // Initialize the mint (Attention Token Mint)
        token::initialize_mint(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::InitializeMint {
                    mint: ctx.accounts.attention_token_mint.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            9,
            &pair.key(),
            Some(&pair.key()),
        )?;

        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        minimum_amount_out: u64,
        is_buy: bool,
    ) -> Result<()> {
        let pair = &ctx.accounts.pair;

        let amount_out = calculate_output_amount(amount_in, pair.base_price)?;
        require!(amount_out >= minimum_amount_out, FactoryError::SlippageExceeded);

        let creator_fee = amount_in.checked_mul(pair.creator_fee).unwrap().checked_div(10000).unwrap();
        let vault_bump = ctx.bumps.vault;
        let binding = pair.key();
        let vault_seeds = &[
            b"vault",
            binding.as_ref(),
            &[vault_bump],
        ];
        if is_buy {
            // Transfer SOL from user to vault
            invoke(
                &system_instruction::transfer(
                    &ctx.accounts.user.key(),
                    &ctx.accounts.vault.key(),
                    amount_in,
                ),
                &[
                    ctx.accounts.user.to_account_info(),
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;

            // Transfer creator fee from vault to creator
            if creator_fee > 0 {
                invoke_signed(
                    &system_instruction::transfer(
                        &ctx.accounts.vault.key(),
                        &ctx.accounts.creator.key(),
                        creator_fee,
                    ),
                    &[
                        ctx.accounts.vault.to_account_info(),  
                        ctx.accounts.creator.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                    &[vault_seeds],
                )?;
            }

            // Mint attention tokens to the user
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::MintTo {
                        mint: ctx.accounts.attention_token_mint.to_account_info(),
                        to: ctx.accounts.user_token_account.to_account_info(),
                        authority: ctx.accounts.pair.to_account_info(),
                    },
                    &[&[
                        b"pair",
                        ctx.accounts.creator.key().as_ref(),
                        pair.creation_number.to_le_bytes().as_ref(),
                        &[pair.bump],
                    ]],
                ),
                amount_out,
            )?;
        } else {
            // Sell: User burns tokens
            token::burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Burn {
                        mint: ctx.accounts.attention_token_mint.to_account_info(),
                        from: ctx.accounts.user_token_account.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;

            // Transfer SOL from vault to user
            invoke_signed(
                &system_instruction::transfer(
                    &ctx.accounts.vault.key(),
                    &ctx.accounts.user.key(),
                    amount_out,
                ),
                &[
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.user.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[vault_seeds],
            )?;
        }

        Ok(())
    }
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
        space = 3500
    )]
    pub pair: Account<'info, Pair>,
    
    /// CHECK: Initialized by CPI later
    #[account(mut)]
    pub attention_token_mint: UncheckedAccount<'info>,
    
    /// CHECK: Created by token program for the creator if needed
    #[account(mut)]
    pub creator_token_account: UncheckedAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: PDA owned by the system program
    #[account(
        init,
        payer = creator,
        space = 0,
        seeds = [b"vault", pair.key().as_ref()],
        bump,
        owner = system_program::ID
    )]
    pub vault: UncheckedAccount<'info>,  // Changed back to UncheckedAccount
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub pair: Account<'info, Pair>,
    
    /// CHECK: SPL Token mint account
    #[account(mut)]
    pub attention_token_mint: UncheckedAccount<'info>,
    
    /// CHECK: SPL Token account
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: Creator account to pay creator fees
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    #[account(mut)]
    pub factory: Account<'info, Factory>,

    /// CHECK: System program owned vault PDA
    #[account(
        mut,
        seeds = [b"vault", pair.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,
}

#[account]
#[derive(Default)]
pub struct Factory {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub protocol_fee: u64,
    pub pairs_count: u64,
}

#[account]
#[derive(Default)]
pub struct Pair {
    pub bump: u8,
    pub creator: Pubkey,
    pub attention_token_mint: Pubkey,
    pub creator_token_account: Pubkey,
    pub base_price: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    pub creation_number: u64,
    pub vault: Pubkey, // New field for vault

    pub name: String,
    pub ticker: String,
    pub description: String,
    pub token_image: String,
    pub twitter: String,
    pub telegram: String,
    pub website: String,
    pub requests: Vec<RequestConfig>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct RequestConfig {
    pub price: u64,
    pub description: String,
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
    pub base_price: u64,
    pub requests: Vec<RequestConfig>,
}

#[error_code]
pub enum FactoryError {
    #[msg("Protocol fee must be between 0 and 10000 (100%)")]
    InvalidProtocolFee,
    #[msg("Base price must be greater than 0")]
    InvalidBasePrice,
    #[msg("String length exceeds maximum allowed")]
    InvalidStringLength,
    #[msg("Request price must be greater than 0")]
    InvalidRequestPrice,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
}

fn calculate_output_amount(amount_in: u64, base_price: u64) -> Result<u64> {
    require!(base_price > 0, FactoryError::InvalidBasePrice);
    let amount_out = amount_in.checked_div(base_price).ok_or(FactoryError::InvalidBasePrice)?;
    Ok(amount_out)
}
