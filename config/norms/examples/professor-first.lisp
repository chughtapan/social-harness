(norm professor-first
  :description "A student's agent, the client, requests a meeting topic from a professor's agent, the server. The server proposes candidate times; before confirmation the server may replace an offer and the client may revise which offered times are suitable. The client returns every offered option it can attend, or rejects all options. The server confirms one currently accepted time. Either may cancel the negotiation or confirmed agreement; rescheduling starts a new request after cancellation.")

(content request :by client :starts true :initiates negotiating
  (field topic :type string :min-length 1
    :description "The meeting subject. Its duration, a broad timeframe such as next week and dates that belong to the subject are allowed; availability and proposed meeting times are not."))

(content propose :by server :when negotiating
  :initiates offered :terminates accepted
  (field option1 :type string :min-length 1
    :description "One candidate meeting slot: a date, start and end times, and a timezone.")
  (field option2 :type string :min-length 1 :optional true
    :description "One candidate meeting slot: a date, start and end times, and a timezone.")
  (field option3 :type string :min-length 1 :optional true
    :description "One candidate meeting slot: a date, start and end times, and a timezone."))

(content accept-proposal :by client :when (negotiating offered) :initiates accepted
  (field available :type multi-select :choices (option1 option2 option3)
    :min-items 1 :max-items 3)
  (relation subset available (present (fact offered) option1 option2 option3)))

(content reject-proposal :by client :when (negotiating offered) :terminates accepted)

(content confirm :by server :when (negotiating offered accepted) :initiates confirmed
  :terminates (negotiating offered accepted)
  (field slot :type string :min-length 1
    :description "The agreed meeting slot, copied exactly from the offer.")
  (relation member slot (values (fact offered) (previous (fact accepted) available))))

(content cancel :by (client server) :ends true)
