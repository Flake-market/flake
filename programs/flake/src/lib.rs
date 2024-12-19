use anchor_lang::{prelude::*, solana_program, system_program};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Token, Transfer};
use solana_program::program::invoke;
use solana_program::system_instruction;

declare_id!("5cYJsEQDUHGQuZ3SuSRjAN14g23iXtWboqoFJ6fJHtYM");

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

    pub fn create_pair(ctx: Context<CreatePair>, params: CreatePairParams) -> Result<()> {
        require!(params.base_price > 0, FactoryError::InvalidBasePrice);
        require!(
            params.name.len() <= 32 && params.ticker.len() <= 10 && params.description.len() <= 200,
            FactoryError::InvalidStringLength
        );

        for request in &params.requests {
            require!(request.price > 0, FactoryError::InvalidRequestPrice);
            require!(
                request.description.len() <= 200,
                FactoryError::InvalidStringLength
            );
        }

        let pair = &mut ctx.accounts.pair;
        let factory = &mut ctx.accounts.factory;

        // Set fields in pair
        pair.bump = ctx.bumps.pair;
        pair.creator = ctx.accounts.creator.key();
        pair.attention_token_mint = ctx.accounts.attention_token_mint.key();
        pair.creator_token_account = ctx.accounts.creator_token_account.key();
        pair.base_price = params.base_price; // @TODO: to remove 
        pair.protocol_fee = factory.protocol_fee;
        pair.creator_fee = 0; // 1% creator fee
        pair.s0 = 0; 
        pair.pmin = 40000;
        pair.pmax = 100000000;
        pair.smax = 1000000000000000;
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

        emit!(PairCreated {
            pair_id: factory.pairs_count,
            pair_key: pair.key(),
            creator: ctx.accounts.creator.key(),
            base_price: pair.base_price,
        });

        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        minimum_amount_out: u64,
        is_buy: bool,
    ) -> Result<()> {
        let pair = &ctx.accounts.pair;
        let user_key = ctx.accounts.user.key();

        // Example: compute "amount_out" using the new formulae
        let s0 = pair.s0 as f64;
        let pmin = pair.pmin as f64;
        let pmax = pair.pmax as f64;
        let smax = pair.smax as f64;

        // For demonstration, treat "amount_in" as "C" if is_buy,
        // or as "deltaS" if not is_buy. Adjust as needed for your logic.
        let amount_out = if is_buy {
            exact_sol_to_tokens(
                amount_in as f64, // C
                s0,
                pmin,
                pmax,
                smax,
            )
        } else {
            exact_tokens_to_sol(
                s0,
                amount_in as f64, // deltaS
                pmin,
                pmax,
                smax,
            )
        };

        require!(
            amount_out >= minimum_amount_out,
            FactoryError::SlippageExceeded
        );

        // Creator fee
        let creator_fee = amount_in
            .checked_mul(pair.creator_fee)
            .unwrap()
            .checked_div(10000)
            .unwrap();

        // Prepare vault seeds
        let vault_bump = ctx.bumps.vault;
        let seeds = &ctx.accounts.vault_seeds(vault_bump);

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
                    &[seeds],
                )?;
            }
            // Update s0 with new amount_out
            pair.s0 = pair.s0.checked_add(amount_out).unwrap();
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
                        pair.creator.as_ref(),
                        pair.creation_number.to_le_bytes().as_ref(),
                        &[pair.bump],
                    ]],
                ),
                amount_out,
            )?;
        } else {
            // Sell: User burns tokens, then receives SOL from vault
            // Update s0 with new amount_in
            pair.s0 = pair.s0.checked_sub(amount_in).unwrap();
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

            invoke_signed(
                &system_instruction::transfer(
                    &ctx.accounts.vault.key(),
                    &user_key,
                    amount_out,
                ),
                &[
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.user.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }

        // Emit the new event so we know it was a buy or sell, amounts, etc.
        emit!(SwapExecuted {
            is_buy,
            amount_in,
            amount_out,
            user: user_key,
            pair_key: pair.key(),
            attention_token_mint: ctx.accounts.attention_token_mint.key()
        });

        Ok(())
    }

    pub fn submit_request(
        ctx: Context<SubmitRequest>,
        request_index: u8,
        ad_text: String,
    ) -> Result<()> {
        let pair = &mut ctx.accounts.pair;

        // Validate request index
        require!(
            (request_index as usize) < pair.requests.len(),
            FactoryError::InvalidRequestIndex
        );

        // Validate ad text length
        require!(ad_text.len() <= 280, FactoryError::AdTextTooLong);

        // Get required token amount from requests config
        let required_tokens = pair.requests[request_index as usize].price;

        // Transfer tokens from user to creator
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            required_tokens,
        )?;

        // Create and store the request
        let request = Request {
            user: ctx.accounts.user.key(),
            request_index,
            ad_text,
            timestamp: Clock::get()?.unix_timestamp,
            status: RequestStatus::Pending,
        };

        pair.pending_requests.push(request.clone());

        // Emit event
        emit!(RequestSubmitted {
            pair_key: pair.key(),
            user: request.user,
            request_index: request.request_index,
            ad_text: request.ad_text,
            timestamp: request.timestamp,
        });

        Ok(())
    }
    pub fn accept_request(ctx: Context<AcceptRequest>, request_index: u8) -> Result<()> {
        let pair = &mut ctx.accounts.pair;

        // Find the pending request by both index and pending status
        let request_position = pair
            .pending_requests
            .iter()
            .position(|r| r.request_index == request_index && r.status == RequestStatus::Pending)
            .ok_or(FactoryError::RequestNotFound)?;

        let request = &mut pair.pending_requests[request_position];

        // No need to check status again since we filtered for Pending above
        request.status = RequestStatus::Accepted;

        // Emit event
        emit!(RequestAccepted {
            creator: ctx.accounts.creator.key(),
            request_index: request.request_index,
            user: request.user,
            timestamp: Clock::get()?.unix_timestamp,
        });

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
        space = 8 + // discriminator
        1 + // bump
        32 + // creator
        32 + // attention_token_mint
        32 + // creator_token_account
        8 + // base_price
        8 + // protocol_fee
        8 + // creator_fee
        8 + // creation_number
        32 + // vault
        36 + // name (32 + 4)
        14 + // ticker (10 + 4)
        204 + // description (200 + 4)
        204 + // token_image (200 + 4)
        104 + // twitter (100 + 4)
        104 + // telegram (100 + 4)
        104 + // website (100 + 4)
        4 + (3 * (8 + 104)) + // requests (Vec<RequestConfig>, assume max 3 items)
        4 + (10 * (32 + 1 + 104 + 8 + 1)) + // pending_requests (Vec<Request>, assume max 10 items)
        8 + // s0
        8 + // pmin
        8 + // pmax
        8 // smax
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
    pub vault: UncheckedAccount<'info>, // Changed back to UncheckedAccount
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

impl<'info> Swap<'info> {
    fn vault_seeds(&self, vault_bump: u8) -> [&[u8]; 3] {
        let binding = self.pair.key();
        [b"vault", binding.as_ref(), &[vault_bump]]
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
    pub vault: Pubkey,
    pub name: String,
    pub ticker: String,
    pub description: String,
    pub token_image: String,
    pub twitter: String,
    pub telegram: String,
    pub website: String,
    pub requests: Vec<RequestConfig>,
    pub pending_requests: Vec<Request>,
    pub s0: u64,
    pub pmin: u64,
    pub pmax: u64,
    pub smax: u64,
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
    #[msg("Invalid request index")]
    InvalidRequestIndex,
    #[msg("Ad text too long")]
    AdTextTooLong,
    #[msg("Insufficient tokens")]
    InsufficientTokens,
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Request not found or not in pending status")]
    RequestNotFound,
    #[msg("Request has already been processed")]
    RequestAlreadyProcessed,
}

#[event]
pub struct PairCreated {
    pub pair_id: u64,
    pub pair_key: Pubkey,
    pub creator: Pubkey,
    pub base_price: u64,
}

#[derive(Accounts)]
pub struct SubmitRequest<'info> {
    #[account(mut)]
    pub pair: Account<'info, Pair>,

    /// CHECK: SPL Token mint account
    #[account(mut)]
    pub attention_token_mint: UncheckedAccount<'info>,

    /// CHECK: SPL Token account that holds the tokens to be spent
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,

    /// CHECK: Creator's token account to receive tokens
    #[account(mut)]
    pub creator_token_account: UncheckedAccount<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct Request {
    pub user: Pubkey,
    pub request_index: u8,
    pub ad_text: String,
    pub timestamp: i64,
    pub status: RequestStatus,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, PartialEq)]
pub enum RequestStatus {
    #[default]
    Pending,
    Accepted,
    Rejected,
    Refunded,
}

#[event]
pub struct RequestSubmitted {
    pub pair_key: Pubkey,
    pub user: Pubkey,
    pub request_index: u8,
    pub ad_text: String,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct AcceptRequest<'info> {
    #[account(mut)]
    pub pair: Account<'info, Pair>,

    #[account(
        mut,
        constraint = creator.key() == pair.creator @ FactoryError::UnauthorizedCaller
    )]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct RequestAccepted {
    pub creator: Pubkey,
    pub request_index: u8,
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct SwapExecuted {
    pub is_buy: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub user: Pubkey,
    pub pair_key: Pubkey,
    pub attention_token_mint: Pubkey,
}

/// Approximates the "exactSolToTokens" logic using floating-point math.
/// In practice, consider fixed-point arithmetic or careful rounding for precision.
fn exact_sol_to_tokens(c: f64, s0: f64, pmin: f64, pmax: f64, smax: f64) -> u64 {
    let a = (pmax - pmin) / (2.0 * smax);
    let b = pmin + (pmax - pmin) * (s0 / smax);
    let discriminant = b * b + 4.0 * a * c;
    // Quadratic: A*(ΔS)^2 + B*(ΔS) - C = 0, solve for ΔS ≥ 0
    let delta_s = (-b + discriminant.sqrt()) / (2.0 * a);
    // Simple floor for a u64 result (you may also wish to handle negative or zero gracefully)
    delta_s.floor() as u64
}

/// Approximates the "exactTokensToSol" logic using floating-point math.
fn exact_tokens_to_sol(s0: f64, delta_s: f64, pmin: f64, pmax: f64, smax: f64) -> u64 {
    let term1 = pmin * delta_s;
    let term2 = ((pmax - pmin) / (2.0 * smax)) * (2.0 * s0 * delta_s - delta_s * delta_s);
    (term1 + term2).floor() as u64
}
