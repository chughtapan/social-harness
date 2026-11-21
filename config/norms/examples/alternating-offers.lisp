(norm alternating-offers
  :description "A student's agent, the client, opens with a topic and candidate meeting slots for a professor's agent, the server. The recipient of an offer accepts one offered slot, or rejects the offer and proposes alternatives in one counter-propose message. Counteroffers alternate between the two. Only the recipient of the current offer may counteroffer or accept it. Acceptance by either completes the agreement; no further confirmation or acknowledgement is needed. Either may cancel a pending negotiation or the agreed meeting without giving a reason. After cancellation, the client may open a new request-propose.")

(content request-propose :by client :starts true :initiates offered
  (field topic :type string :min-length 1
    :description "The meeting subject. Its duration and a broad timeframe such as next week are allowed; candidate times belong in options.")
  (field options :type list :min-items 1 :max-items 3
    :description "One candidate meeting slot: a date, start and end times, and a timezone."))

(content counter-propose :by (recipient (fact offered))
  :when offered :initiates offered
  (field options :type list :min-items 1 :max-items 3
    :description "One candidate meeting slot: a date, start and end times, and a timezone."))

(content accept-proposal :by (recipient (fact offered))
  :when offered :terminates offered :initiates agreed
  (field slot :type string :min-length 1
    :description "One slot of the current offer, copied exactly.")
  (relation member slot (previous (fact offered) options)))

(content cancel :by (client server) :ends true)
