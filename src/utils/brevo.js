/**
 * Syncs a registered user to Brevo in real-time.
 * Adds them to the 'Usuarios Registrados Web' list (ID 6) and sets attributes.
 * Uses process.env.EMAIL_PASS as the Brevo API key.
 * 
 * @param {string} email User email address
 * @param {string} language 'es' or 'en'
 * @param {Date} [registrationDate] Optional date of registration, defaults to now
 */
export async function syncContactToBrevo(email, language, registrationDate = new Date()) {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
        console.warn('[BREVO-SYNC] No BREVO_API_KEY API key found in environment.');
        return;
    }

    const formattedDate = registrationDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const langCode = (language || 'es').toLowerCase();
    const listId = 6; // 'Usuarios Registrados Web' list ID in Brevo

    const headers = {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
    };

    const payload = {
        email: email,
        attributes: {
            LANGUAGE: langCode,
            REGISTRATION_DATE: formattedDate
        },
        listIds: [listId]
    };

    try {
        console.log(`[BREVO-SYNC] Attempting to sync contact: ${email} (Lang: ${langCode}, Date: ${formattedDate})`);
        
        // Try to create the contact
        const createResponse = await fetch('https://api.brevo.com/v3/contacts', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (createResponse.status === 201 || createResponse.status === 204) {
            console.log(`[BREVO-SYNC] Contact created successfully in Brevo: ${email}`);
            return;
        }

        const createResult = await createResponse.json();
        
        // If contact already exists (error code: "duplicate_parameter")
        if (createResponse.status === 400 && createResult.code === 'duplicate_parameter') {
            console.log(`[BREVO-SYNC] Contact ${email} already exists. Updating attributes and list membership...`);
            
            // Update attributes and add to list via PUT
            const updatePayload = {
                attributes: {
                    LANGUAGE: langCode,
                    REGISTRATION_DATE: formattedDate
                },
                listIds: [listId]
            };

            const updateResponse = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
                method: 'PUT',
                headers: headers,
                body: JSON.stringify(updatePayload)
            });

            if (updateResponse.status === 204 || updateResponse.status === 200) {
                console.log(`[BREVO-SYNC] Contact updated successfully in Brevo: ${email}`);
            } else {
                const updateError = await updateResponse.text();
                console.error(`[BREVO-SYNC] Failed to update existing contact ${email}:`, updateError);
                throw new Error(`Failed to update existing contact: ${updateError}`);
            }
        } else {
            console.error(`[BREVO-SYNC] Error creating contact ${email}:`, JSON.stringify(createResult));
            throw new Error(createResult.message || `Failed to create contact: ${JSON.stringify(createResult)}`);
        }
    } catch (err) {
        console.error(`[BREVO-SYNC] Exception during contact sync for ${email}:`, err.message);
        throw err;
    }
}
